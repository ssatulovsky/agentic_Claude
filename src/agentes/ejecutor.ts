import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { registrarEnBitacora } from '../bitacora/bitacora.js';
import { enContexto, type ContextoSeguridad, type Db, type Trx } from '../db/conexion.js';
import { ErrorNegocio, noEncontrado, sinPermiso, traducirErrorBaseDatos } from '../errores.js';
import { moduloVigente, permisosEnEmpresa } from '../seguridad/permisos.js';
import type { RegistroAgentes } from './catalogo.js';
import type { DefinicionHerramienta, MotivoDenegacion, ResultadoHerramienta } from './tipos.js';

export interface Solicitante {
  usuarioId: string;
  empresaId: string;
  /** Canal de la consulta. Por WhatsApp nada se ejecuta sin aprobación en la web (sin doble factor por mensaje). */
  canal?: 'WEB' | 'WHATSAPP';
}

export interface PeticionHerramienta {
  agenteCodigo: string;
  solicitante: Solicitante;
  nombre: string;
  entrada: unknown;
  fecha: string;
  conversacionId?: string;
  paso?: number;
}

const hoy = () => new Date().toISOString().slice(0, 10);

function contextoAgente(agenteCodigo: string, s: Solicitante): ContextoSeguridad & { empresaId: string } {
  // El agente actúa con la identidad de la persona que pregunta: la base de datos
  // le muestra exactamente lo que esa persona puede ver, ni un dato más.
  return { usuarioId: s.usuarioId, empresaId: s.empresaId, actorTipo: 'AGENTE', actorId: agenteCodigo };
}

export async function registrarTraza(
  trx: Trx,
  datos: {
    empresaId: string;
    conversacionId: string;
    usuarioId: string;
    agenteCodigo: string;
    paso: number;
    tipo: 'MENSAJE_USUARIO' | 'LLAMADA_HERRAMIENTA' | 'RESULTADO_HERRAMIENTA' | 'DENEGADO' | 'PROPUESTA_CREADA' | 'RESPUESTA' | 'ERROR';
    contenido: unknown;
  },
): Promise<void> {
  await trx
    .insertInto('trazas_agente')
    .values({
      empresa_id: datos.empresaId,
      conversacion_id: datos.conversacionId,
      usuario_id: datos.usuarioId,
      agente_codigo: datos.agenteCodigo,
      paso: datos.paso,
      tipo: datos.tipo,
      contenido: JSON.stringify(datos.contenido ?? null),
    })
    .execute();
}

/** Ejecuta la herramienta dentro de un punto de guardado: si falla, no arrastra la transacción. */
async function ejecutarAislado<T>(trx: Trx, fn: () => Promise<T>): Promise<{ ok: true; valor: T } | { ok: false; error: ErrorNegocio }> {
  await sql`SAVEPOINT herramienta`.execute(trx);
  try {
    const valor = await fn();
    await sql`RELEASE SAVEPOINT herramienta`.execute(trx);
    return { ok: true, valor };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT herramienta`.execute(trx);
    if (error instanceof ErrorNegocio) return { ok: false, error };
    const traducido = traducirErrorBaseDatos(error);
    if (traducido) return { ok: false, error: traducido };
    throw error;
  }
}

/**
 * Punto único por el que un agente usa una herramienta. Verifica, en orden:
 * 1) que la herramienta exista y esté asignada al agente;
 * 2) que la entrada sea válida;
 * 3) que la empresa tenga el módulo contratado y el agente activo;
 * 4) que la PERSONA que consulta tenga el permiso de la herramienta;
 * 5) el nivel de autonomía: consultar se ejecuta; lo demás queda como propuesta,
 *    salvo EJECUTAR_CON_AVISO cuando la empresa lo autorizó para ese agente.
 * Cada paso queda en las trazas de la conversación.
 */
export async function ejecutarHerramienta(db: Db, registro: RegistroAgentes, p: PeticionHerramienta): Promise<ResultadoHerramienta> {
  const conversacionId = p.conversacionId ?? randomUUID();
  const paso = p.paso ?? 1;
  const ctx = contextoAgente(p.agenteCodigo, p.solicitante);

  return enContexto(db, ctx, async (trx) => {
    const traza = (tipo: Parameters<typeof registrarTraza>[1]['tipo'], contenido: unknown) =>
      registrarTraza(trx, {
        empresaId: p.solicitante.empresaId,
        conversacionId,
        usuarioId: p.solicitante.usuarioId,
        agenteCodigo: p.agenteCodigo,
        paso,
        tipo,
        contenido,
      });

    const denegar = async (motivo: MotivoDenegacion, mensaje: string): Promise<ResultadoHerramienta> => {
      await traza('DENEGADO', { herramienta: p.nombre, motivo, mensaje });
      return { estado: 'DENEGADA', motivo, mensaje };
    };

    await traza('LLAMADA_HERRAMIENTA', { herramienta: p.nombre, entrada: p.entrada });

    const agente = registro.agente(p.agenteCodigo);
    const herramienta = registro.herramienta(p.nombre);
    if (!agente || !herramienta) {
      return denegar('HERRAMIENTA_DESCONOCIDA', `La herramienta ${p.nombre} no existe.`);
    }
    if (!agente.herramientas.includes(herramienta.nombre)) {
      return denegar('HERRAMIENTA_NO_ASIGNADA', `${agente.cargo} no tiene asignada la herramienta ${herramienta.nombre}.`);
    }

    const entrada = herramienta.entrada.safeParse(p.entrada);
    if (!entrada.success) {
      return denegar(
        'ENTRADA_INVALIDA',
        `Entrada inválida: ${entrada.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`,
      );
    }

    if (herramienta.modulo && !(await moduloVigente(trx, p.solicitante.empresaId, herramienta.modulo, p.fecha))) {
      return denegar('MODULO_NO_CONTRATADO', `La empresa no tiene contratado el módulo ${herramienta.modulo}.`);
    }

    const config = await trx
      .selectFrom('agentes_config_empresa')
      .select(['activo', 'autonomia_maxima'])
      .where('empresa_id', '=', p.solicitante.empresaId)
      .where('agente_codigo', '=', p.agenteCodigo)
      .executeTakeFirst();
    if (config && !config.activo) {
      return denegar('AGENTE_DESACTIVADO', `${agente.cargo} está desactivado para esta empresa.`);
    }

    const permisos = await permisosEnEmpresa(trx, p.solicitante.empresaId);
    if (!permisos.has(herramienta.permiso)) {
      return denegar('SIN_PERMISO', `Su perfil no tiene el permiso ${herramienta.permiso}.`);
    }

    const ejecutaDirecto =
      herramienta.autonomia === 'CONSULTAR' ||
      (herramienta.autonomia === 'EJECUTAR_CON_AVISO' &&
        config?.autonomia_maxima === 'EJECUTAR_CON_AVISO' &&
        p.solicitante.canal !== 'WHATSAPP');

    if (!ejecutaDirecto) {
      const resumen = herramienta.resumir?.(entrada.data) ?? `${herramienta.nombre}: ${JSON.stringify(entrada.data)}`;
      const propuesta = await trx
        .insertInto('propuestas_agente')
        .values({
          empresa_id: p.solicitante.empresaId,
          agente_codigo: p.agenteCodigo,
          herramienta: herramienta.nombre,
          autonomia: herramienta.autonomia === 'EJECUTAR_CON_APROBACION' ? 'EJECUTAR_CON_APROBACION' : 'PROPONER',
          solicitado_por: p.solicitante.usuarioId,
          entrada: JSON.stringify(entrada.data),
          resumen,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await traza('PROPUESTA_CREADA', { herramienta: herramienta.nombre, propuestaId: propuesta.id, resumen });
      return { estado: 'PROPUESTA_CREADA', propuestaId: propuesta.id, resumen };
    }

    const resultado = await ejecutarAislado(trx, () =>
      herramienta.ejecutar({ trx, seguridad: ctx, agenteCodigo: p.agenteCodigo, fecha: p.fecha }, entrada.data),
    );
    if (!resultado.ok) {
      return denegar('ERROR_NEGOCIO', resultado.error.message);
    }
    if (herramienta.autonomia === 'EJECUTAR_CON_AVISO') {
      await registrarEnBitacora(trx, {
        actorTipo: 'AGENTE',
        actorId: p.agenteCodigo,
        accion: 'agente.ejecucion_con_aviso',
        entidad: 'herramienta',
        entidadId: herramienta.nombre,
        datos: { entrada: entrada.data },
        empresaId: p.solicitante.empresaId,
        enNombreDe: p.solicitante.usuarioId,
      });
    }
    await traza('RESULTADO_HERRAMIENTA', { herramienta: herramienta.nombre, resultado: resultado.valor });
    return { estado: 'EJECUTADA', resultado: resultado.valor };
  });
}

export type DecisionPropuesta = 'APROBAR' | 'RECHAZAR';

/**
 * Una persona aprueba o rechaza una propuesta de un agente. Quien aprueba debe
 * tener el permiso agentes.aprobar Y el permiso propio de la herramienta: nadie
 * puede aprobar algo que no podría hacer por sí mismo.
 */
export async function resolverPropuesta(
  db: Db,
  registro: RegistroAgentes,
  revisor: Solicitante,
  propuestaId: string,
  decision: DecisionPropuesta,
  motivo: string | null = null,
): Promise<{ estado: string; resultado?: unknown }> {
  const ctx: ContextoSeguridad & { empresaId: string } = {
    usuarioId: revisor.usuarioId,
    empresaId: revisor.empresaId,
    actorTipo: 'USUARIO',
    actorId: revisor.usuarioId,
  };
  return enContexto(db, ctx, async (trx) => {
    const permisos = await permisosEnEmpresa(trx, revisor.empresaId);
    if (!permisos.has('agentes.aprobar')) throw sinPermiso('agentes.aprobar');

    const propuesta = await trx
      .selectFrom('propuestas_agente')
      .selectAll()
      .where('id', '=', propuestaId)
      .where('empresa_id', '=', revisor.empresaId)
      .forUpdate()
      .executeTakeFirst();
    if (!propuesta) throw noEncontrado('La propuesta');
    if (propuesta.estado !== 'PENDIENTE') {
      throw new ErrorNegocio('PROPUESTA_YA_RESUELTA', `La propuesta ya está en estado ${propuesta.estado}.`, 409);
    }
    if (new Date(propuesta.vence_en) <= new Date()) {
      // Se registra el vencimiento (y quién lo constató) y se informa sin ejecutar nada.
      await trx
        .updateTable('propuestas_agente')
        .set({ estado: 'VENCIDA', revisado_por: revisor.usuarioId, revisado_en: new Date(), motivo: 'Venció sin revisión' })
        .where('id', '=', propuestaId)
        .execute();
      return { estado: 'VENCIDA' };
    }

    const herramienta: DefinicionHerramienta | undefined = registro.herramienta(propuesta.herramienta);
    if (!herramienta) throw new ErrorNegocio('HERRAMIENTA_DESCONOCIDA', 'La herramienta de la propuesta ya no existe.', 409);

    const marcar = (estado: 'RECHAZADA' | 'EJECUTADA' | 'FALLIDA', resultado: unknown, nota: string | null) =>
      trx
        .updateTable('propuestas_agente')
        .set({
          estado,
          resultado: resultado === undefined ? null : JSON.stringify(resultado),
          revisado_por: revisor.usuarioId,
          revisado_en: new Date(),
          motivo: nota,
        })
        .where('id', '=', propuestaId)
        .execute();

    if (decision === 'RECHAZAR') {
      await marcar('RECHAZADA', undefined, motivo);
      return { estado: 'RECHAZADA' };
    }

    if (!permisos.has(herramienta.permiso)) throw sinPermiso(herramienta.permiso);
    if (herramienta.modulo && !(await moduloVigente(trx, revisor.empresaId, herramienta.modulo, hoy()))) {
      throw new ErrorNegocio('MODULO_NO_CONTRATADO', `La empresa no tiene contratado el módulo ${herramienta.modulo}.`, 403);
    }
    const entrada = herramienta.entrada.parse(propuesta.entrada);
    const resultado = await ejecutarAislado(trx, () =>
      herramienta.ejecutar({ trx, seguridad: ctx, agenteCodigo: propuesta.agente_codigo, fecha: hoy(), propuestaId }, entrada),
    );
    if (!resultado.ok) {
      await marcar('FALLIDA', { error: resultado.error.codigo }, resultado.error.message);
      return { estado: 'FALLIDA', resultado: { error: resultado.error.message } };
    }
    await marcar('EJECUTADA', resultado.valor, motivo);
    return { estado: 'EJECUTADA', resultado: resultado.valor };
  });
}
