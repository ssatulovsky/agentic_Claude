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
 * Ejecuta la acción dentro de un punto de restauración, con la identidad de la persona que
 * pidió (actor USUARIO), y siempre la deshace: también se revierten la identidad declarada,
 * la bitácora, los bloqueos y los correlativos. `preparar` corre dentro del mismo punto (la
 * propuesta borrador), lo más tarde posible.
 */
async function ensayar(trx: Trx, usuarioId: string, preparar: () => Promise<void>, fn: () => Promise<unknown>): Promise<Hallazgo | null> {
  await sql`SAVEPOINT ensayo_contralor`.execute(trx);
  try {
    await sql`SELECT set_config('app.actor_tipo', 'USUARIO', true), set_config('app.actor_id', ${usuarioId}, true)`.execute(trx);
    await preparar();
    await fn();
    return null;
  } catch (error) {
    const negocio = error instanceof ErrorNegocio ? error : traducirErrorBaseDatos(error);
    if (!negocio) throw error;
    // El ensayo corre con los permisos de quien pidió; la aprobación, con los de quien aprueba.
    // Si a quien pidió le falta un permiso de la acción, no es un error de la propuesta.
    if (negocio.codigo === 'SIN_PERMISO') {
      return {
        nivel: 'OBSERVACION',
        codigo: 'REQUIERE_APROBADOR_CON_PERMISO',
        mensaje: 'No se pudo ensayar completa con los permisos de quien la pidió: debe aprobarla alguien con todos los permisos de la acción.',
      };
    }
    return { nivel: 'BLOQUEANTE', codigo: negocio.codigo, mensaje: negocio.message };
  } finally {
    await sql`ROLLBACK TO SAVEPOINT ensayo_contralor`.execute(trx);
    await sql`RELEASE SAVEPOINT ensayo_contralor`.execute(trx);
  }
}

/**
 * Revisa una propuesta. `ctx.propuestaId` es el id que tendrá la propuesta; `prepararEnsayo`
 * crea la propuesta borrador con ese id dentro del ensayo, como en la aprobación real.
 */
export async function revisarPropuesta<E>(
  trx: Trx,
  ctx: ContextoHerramienta & { propuestaId: string },
  herramienta: DefinicionHerramienta<E, unknown>,
  entrada: E,
  prepararEnsayo: () => Promise<void>,
): Promise<{ dictamen: Dictamen; hallazgos: Hallazgo[] }> {
  const hallazgos: Hallazgo[] = [];
  const entradaJson = JSON.stringify(entrada);

  // Una propuesta idéntica ya pendiente (de cualquier persona): aprobar ambas duplicaría el
  // efecto. El bloqueo serializa dos pedidos idénticos simultáneos hasta el fin de la transacción.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.seguridad.empresaId}|${herramienta.nombre}|${entradaJson}`}, 0))`.execute(trx);
  const { rows: duplicadas } = await sql<{ n: number }>`
    SELECT contralor_propuestas_identicas(${ctx.seguridad.empresaId}::uuid, ${herramienta.nombre}, ${entradaJson}::jsonb) AS n`.execute(trx);
  if ((duplicadas[0]?.n ?? 0) > 0) {
    hallazgos.push({
      nivel: 'BLOQUEANTE',
      codigo: 'PROPUESTA_DUPLICADA',
      mensaje: 'Ya hay una propuesta idéntica pendiente de aprobación; aprobar ambas duplicaría el efecto.',
    });
  }

  // Revisiones propias de la herramienta (criterio contable, montos, fechas): solo lectura.
  if (herramienta.revisar) hallazgos.push(...(await herramienta.revisar(ctx, entrada)));

  // Ensayo con las mismas validaciones del núcleo y de la base de datos.
  if (herramienta.ensayable !== false && !hallazgos.some((h) => h.nivel === 'BLOQUEANTE')) {
    const comoPersona = { ...ctx, seguridad: { ...ctx.seguridad, actorTipo: 'USUARIO' as const, actorId: ctx.seguridad.usuarioId } };
    const fallo = await ensayar(trx, ctx.seguridad.usuarioId, prepararEnsayo, () => herramienta.ejecutar(comoPersona, entrada));
    if (fallo) hallazgos.push(fallo.nivel === 'BLOQUEANTE' ? { ...fallo, mensaje: `Al ensayar la acción: ${fallo.mensaje}` } : fallo);
  }

  return { dictamen: dictaminar(hallazgos), hallazgos };
}

// ---------------------------------------------------------------------------
// Control de cifras de las respuestas
// ---------------------------------------------------------------------------

export interface Cifra {
  texto: string;
  valor: number;
  porcentaje: boolean;
}

const MULTIPLICADORES: Record<string, number> = { mil: 1e3, millon: 1e6, 'millón': 1e6, millones: 1e6, mm: 1e6, 'mil millones': 1e9 };

/**
 * Cifras de un texto en formato chileno: "$2.991.000", "-$5.000", "0,25%", "12.5%", "1.234,5",
 * "$2,9 millones", "MM$ 3,5", "$1,234,567". No son cifras: años sueltos, fechas, RUT, códigos
 * de cuenta (1.1.02, o lo que sigue a "cuenta"), horas, ni números de una o dos cifras.
 */
export function cifrasDelTexto(texto: string): Cifra[] {
  const limpio = texto
    .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/gu, ' ')
    .replace(/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/gu, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/gu, ' ')
    .replace(/\bcuentas?\s+(?:N°\s*)?\d+(?:\.\d+)*/giu, ' ')
    .replace(/\b\d{1,2}(?:\.\d{1,2}){2,}\b(?!\d)/gu, ' ');
  const cifras: Cifra[] = [];
  const patron =
    /(-\s?)?(MM\$|US\$|\$)?\s?(-\s?)?(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3}){2,}|\d+)(?:([,.])(\d+))?(\s?%)?(?:\s?(mil millones|millones|millón|millon|mil|MM)\b)?/giu;
  for (const m of limpio.matchAll(patron)) {
    const [completo, signo1, moneda, signo2, entero, sepDecimal, decimales, porcentaje, multiplicador] = m;
    const esPorcentaje = Boolean(porcentaje);
    // Un punto como decimal solo se acepta en porcentajes ("12.5%"); si no, "1.5" queda fuera.
    if (sepDecimal === '.' && !esPorcentaje) continue;
    const enteroLimpio = entero!.includes(',') ? entero!.replace(/,/gu, '') : entero!.replace(/\./gu, '');
    let valor = Number(`${enteroLimpio}${decimales ? `.${decimales}` : ''}`);
    if (!Number.isFinite(valor)) continue;
    const factor = (multiplicador ? MULTIPLICADORES[multiplicador.toLowerCase()] : undefined) ?? (moneda?.toUpperCase() === 'MM$' ? 1e6 : 1);
    valor *= factor;
    if (signo1 || signo2) valor = -valor;
    const absoluto = Math.abs(valor);
    if (!esPorcentaje && !decimales && factor === 1 && absoluto < 100) continue;
    if (!esPorcentaje && !decimales && !moneda && factor === 1 && /^\d{4}$/u.test(entero!) && absoluto >= 1900 && absoluto <= 2100) continue;
    cifras.push({ texto: completo.trim(), valor, porcentaje: esPorcentaje });
  }
  return cifras;
}

/** Claves de datos que no son cifras de negocio (identificadores y marcas de tiempo). */
const CLAVE_NO_CIFRA = /(^id$|_id$|Id$|^uuid|_en$|^creado|^actualizado|^fecha|hash|^folio_?sii$)/u;
const UUID_O_FECHA = /^[0-9a-f]{8}-[0-9a-f]{4}-|^\d{4}-\d{2}-\d{2}/iu;

/**
 * Números de las fuentes: números JSON, textos que son solo un número ("790000.00") y cifras
 * en formato chileno dentro de textos (lo que dijo la persona). Se conserva el signo.
 */
export function numerosDeFuentes(fuentes: unknown[]): number[] {
  const numeros = new Set<number>();
  const recorrer = (v: unknown, clave?: string) => {
    if (clave && CLAVE_NO_CIFRA.test(clave)) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) numeros.add(v);
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (UUID_O_FECHA.test(t)) return;
      if (/^-?\d+(\.\d+)?$/u.test(t)) numeros.add(Number(t));
      else for (const c of cifrasDelTexto(t)) numeros.add(c.valor);
    } else if (Array.isArray(v)) v.forEach((x) => recorrer(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) recorrer(x, k);
  };
  fuentes.forEach((f) => recorrer(f));
  return [...numeros].sort((a, b) => a - b);
}

/** Índice del primer valor ≥ `minimo` en `ordenados` (búsqueda binaria). */
function desde(ordenados: number[], minimo: number): number {
  let bajo = 0;
  let alto = ordenados.length;
  while (bajo < alto) {
    const medio = (bajo + alto) >> 1;
    if (ordenados[medio]! < minimo) bajo = medio + 1;
    else alto = medio;
  }
  return bajo;
}

/** ¿Hay en `ordenados` un valor que, mostrado redondeado, sea `c`? */
function existeCercano(ordenados: number[], c: number): boolean {
  for (let i = desde(ordenados, c - 1); i < ordenados.length && ordenados[i]! <= c + 1; i++) {
    const f = ordenados[i]!;
    // Igual, o igual al mostrarse redondeado (pesos sin decimales; porcentajes y tasas con dos).
    if (Math.abs(f - c) < 1e-9 || Math.round(f) === c || Math.abs(Math.round(f * 100) / 100 - c) < 1e-9) return true;
  }
  return false;
}

function respaldada(cifra: Cifra, fuentes: number[], admiteSinSigno: boolean): boolean {
  const candidatos = [cifra.valor];
  if (cifra.porcentaje) candidatos.push(cifra.valor / 100);
  // "Pérdida de $5.000.000" puede corresponder a un -5000000 en los datos (y no al revés).
  if (admiteSinSigno) candidatos.push(...candidatos.map((c) => -c));
  return candidatos.some((c) => {
    if (existeCercano(fuentes, c)) return true;
    const unidad = unidadDeRedondeo(c);
    return unidad > 0 && hayEntre(fuentes, c - unidad / 2, c + unidad / 2);
  });
}

/**
 * Una cifra redonda de cien mil o más ("$2,9 millones", "$3 millones") es una forma abreviada
 * de decir un dato: se respalda con uno que, redondeado a esa precisión, dé lo mismo. Devuelve
 * la unidad de redondeo (100.000, 1.000.000, …) o 0 si la cifra no es redonda.
 */
function unidadDeRedondeo(c: number): number {
  const a = Math.abs(c);
  if (a < 1e5 || a % 1e5 !== 0) return 0;
  let unidad = 1e5;
  while (unidad < 1e12 && a % (unidad * 10) === 0) unidad *= 10;
  // A lo más se redondea a dos cifras significativas ("$2,9 millones", no "$3 millones" por 2,6).
  return Math.min(unidad, 10 ** (Math.floor(Math.log10(a)) - 1));
}

function hayEntre(ordenados: number[], minimo: number, maximo: number): boolean {
  const i = desde(ordenados, minimo);
  return i < ordenados.length && ordenados[i]! <= maximo;
}

/** Cifras de la respuesta que no aparecen en ninguna fuente. */
export function cifrasSinRespaldo(respuesta: string, fuentes: unknown[]): string[] {
  const numeros = numerosDeFuentes(fuentes);
  const admiteSinSigno = /p[ée]rdida|negativ|d[ée]ficit|sobregir|en contra|a pagar/iu.test(respuesta);
  const sin = cifrasDelTexto(respuesta)
    .filter((c) => !respaldada(c, numeros, admiteSinSigno))
    .map((c) => c.texto);
  return [...new Set(sin)];
}
export function avisoCifras(cifras: string[]): string {
  return `\n\n⚠️ Contralor: no encontré respaldo en los datos consultados para ${cifras.length === 1 ? 'esta cifra' : 'estas cifras'}: ${cifras.join(', ')}. Verifíquela${cifras.length === 1 ? '' : 's'} antes de usarla${cifras.length === 1 ? '' : 's'}.`;
}
