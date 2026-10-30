import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio, traducirErrorBaseDatos } from '../errores.js';
import type { ContextoHerramienta, DefinicionHerramienta, Hallazgo } from './tipos.js';

/**
 * Contralor: revisión independiente y determinista (núcleo, no un modelo de IA).
 *
 * 1. Revisa cada propuesta de un agente antes de que llegue a una persona: la ensaya con
 *    las mismas validaciones que tendrá al aprobarse (y la deshace), busca duplicados y
 *    aplica las revisiones propias de la herramienta.
 * 2. Controla las cifras de cada respuesta: toda cifra debe venir de los datos que
 *    entregaron las herramientas (o de lo que dijo la persona).
 */

export type { Hallazgo };
export type Dictamen = 'CONFORME' | 'OBSERVADA' | 'RECHAZADA';

export function dictaminar(hallazgos: Hallazgo[]): Dictamen {
  if (hallazgos.some((h) => h.nivel === 'BLOQUEANTE')) return 'RECHAZADA';
  return hallazgos.length > 0 ? 'OBSERVADA' : 'CONFORME';
}

/**
 * Ejecuta la acción dentro de un punto de restauración, como la ejecutaría la persona al
 * aprobarla (actor USUARIO), y siempre la deshace: también se revierten la identidad
 * declarada, la bitácora y los correlativos.
 */
async function ensayar(trx: Trx, usuarioId: string, fn: () => Promise<unknown>): Promise<Hallazgo | null> {
  await sql`SAVEPOINT ensayo_contralor`.execute(trx);
  try {
    await sql`SELECT set_config('app.actor_tipo', 'USUARIO', true), set_config('app.actor_id', ${usuarioId}, true)`.execute(trx);
    await fn();
    return null;
  } catch (error) {
    const negocio = error instanceof ErrorNegocio ? error : traducirErrorBaseDatos(error);
    if (!negocio) throw error;
    return { nivel: 'BLOQUEANTE', codigo: negocio.codigo, mensaje: negocio.message };
  } finally {
    await sql`ROLLBACK TO SAVEPOINT ensayo_contralor`.execute(trx);
    await sql`RELEASE SAVEPOINT ensayo_contralor`.execute(trx);
  }
}

/**
 * Revisa una propuesta. `ctx.propuestaId` es el id que tendrá la propuesta: el ensayo se hace
 * con una propuesta borrador de ese id, como en la aprobación real.
 */
export async function revisarPropuesta<E>(
  trx: Trx,
  ctx: ContextoHerramienta & { propuestaId: string },
  herramienta: DefinicionHerramienta<E, unknown>,
  entrada: E,
): Promise<{ dictamen: Dictamen; hallazgos: Hallazgo[] }> {
  const hallazgos: Hallazgo[] = [];

  // Una propuesta idéntica ya pendiente: aprobar ambas duplicaría el efecto.
  const { rows: duplicadas } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM propuestas_agente
    WHERE empresa_id = ${ctx.seguridad.empresaId}::uuid AND herramienta = ${herramienta.nombre}
      AND estado = 'PENDIENTE' AND entrada = ${JSON.stringify(entrada)}::jsonb AND id <> ${ctx.propuestaId}::uuid`.execute(trx);
  if ((duplicadas[0]?.n ?? 0) > 0) {
    hallazgos.push({
      nivel: 'BLOQUEANTE',
      codigo: 'PROPUESTA_DUPLICADA',
      mensaje: 'Ya hay una propuesta idéntica pendiente de aprobación; aprobar ambas duplicaría el efecto.',
    });
  }

  // Ensayo con las mismas validaciones del núcleo y de la base de datos.
  if (herramienta.ensayable !== false && hallazgos.length === 0) {
    const comoPersona = { ...ctx, seguridad: { ...ctx.seguridad, actorTipo: 'USUARIO' as const, actorId: ctx.seguridad.usuarioId } };
    const fallo = await ensayar(trx, ctx.seguridad.usuarioId, () => herramienta.ejecutar(comoPersona, entrada));
    if (fallo) hallazgos.push({ ...fallo, mensaje: `Al ensayar la acción: ${fallo.mensaje}` });
  }

  // Revisiones propias de la herramienta (criterio contable, montos, fechas).
  if (herramienta.revisar) hallazgos.push(...(await herramienta.revisar(ctx, entrada)));

  return { dictamen: dictaminar(hallazgos), hallazgos };
}

// ---------------------------------------------------------------------------
// Control de cifras de las respuestas
// ---------------------------------------------------------------------------

/**
 * Cifras de un texto, en formato chileno: "$2.991.000", "0,25%", "1.234,5", "790000".
 * No se consideran cifras: años sueltos, fechas, RUT, códigos de cuenta (1.1.02), horas,
 * ni números de una o dos cifras (días, meses, cantidades pequeñas).
 */
export function cifrasDelTexto(texto: string): Array<{ texto: string; valor: number; porcentaje: boolean }> {
  const limpio = texto
    // Fechas (30-09-2026, 2026-09-30, 30/09/2026), RUT y horas fuera.
    .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/gu, ' ')
    .replace(/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/gu, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/gu, ' ')
    // Códigos de cuenta: segmentos de 1 o 2 cifras separados por puntos.
    .replace(/\b\d{1,2}(?:\.\d{1,2}){1,}\b(?!\d)/gu, ' ');
  const cifras: Array<{ texto: string; valor: number; porcentaje: boolean }> = [];
  for (const m of limpio.matchAll(/(-?)\$?\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(\s?%)?/gu)) {
    const [completo, signo, entero, decimales, porcentaje] = m;
    const valor = Number(`${signo}${entero!.replace(/\./gu, '')}${decimales ? `.${decimales}` : ''}`);
    if (!Number.isFinite(valor)) continue;
    const esPorcentaje = Boolean(porcentaje);
    const absoluto = Math.abs(valor);
    // Años sueltos y números pequeños no son cifras de negocio (salvo porcentajes con decimales).
    if (!esPorcentaje && !decimales && absoluto < 100) continue;
    if (!esPorcentaje && !decimales && !completo.includes('$') && !entero!.includes('.') && absoluto >= 1900 && absoluto <= 2100) continue;
    cifras.push({ texto: completo.trim(), valor, porcentaje: esPorcentaje });
  }
  return cifras;
}

/** Todos los números presentes en datos (JSON de herramientas) y en textos (lo que dijo la persona). */
export function numerosDeFuentes(fuentes: unknown[]): Set<number> {
  const numeros = new Set<number>();
  const agregar = (n: number) => {
    if (!Number.isFinite(n)) return;
    numeros.add(n);
    numeros.add(Math.abs(n));
  };
  const recorrer = (v: unknown) => {
    if (typeof v === 'number') agregar(v);
    else if (typeof v === 'string') {
      // Números como texto ("790000.00") y cifras dentro de textos.
      if (/^-?\d+(\.\d+)?$/u.test(v.trim())) agregar(Number(v));
      for (const c of cifrasDelTexto(v)) agregar(c.valor);
      for (const m of v.matchAll(/-?\d+(?:\.\d+)?/gu)) agregar(Number(m[0]));
    } else if (Array.isArray(v)) v.forEach(recorrer);
    else if (v && typeof v === 'object') Object.values(v).forEach(recorrer);
  };
  fuentes.forEach(recorrer);
  return numeros;
}

function respaldada(cifra: { valor: number; porcentaje: boolean }, fuentes: Set<number>): boolean {
  const candidatos = [Math.abs(cifra.valor)];
  if (cifra.porcentaje) candidatos.push(Math.abs(cifra.valor) / 100);
  for (const c of candidatos) {
    for (const f of fuentes) {
      // Igual, o igual al redondear para mostrar (pesos sin decimales, porcentajes con dos).
      if (Math.abs(f - c) < 1e-9 || Math.round(f) === c || Math.abs(Math.round(f * 100) / 100 - c) < 1e-9) return true;
    }
  }
  return false;
}

/** Cifras de la respuesta que no aparecen en ninguna fuente. */
export function cifrasSinRespaldo(respuesta: string, fuentes: unknown[]): string[] {
  const numeros = numerosDeFuentes(fuentes);
  const sin = cifrasDelTexto(respuesta)
    .filter((c) => !respaldada(c, numeros))
    .map((c) => c.texto);
  return [...new Set(sin)];
}

export function avisoCifras(cifras: string[]): string {
  return `\n\n⚠️ Contralor: no encontré respaldo en los datos consultados para ${cifras.length === 1 ? 'esta cifra' : 'estas cifras'}: ${cifras.join(', ')}. Verifíquela${cifras.length === 1 ? '' : 's'} antes de usarla${cifras.length === 1 ? '' : 's'}.`;
}
