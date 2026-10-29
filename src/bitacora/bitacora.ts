import { sql } from 'kysely';
import type { TipoActor, Trx } from '../db/conexion.js';

export interface EventoBitacora {
  actorTipo: TipoActor;
  actorId: string;
  accion: string;
  entidad?: string;
  entidadId?: string;
  datos?: Record<string, unknown>;
  empresaId?: string | null;
  /** Usuario por cuenta de quien actuó un agente. */
  enNombreDe?: string | null;
}

/** Registra un evento en la bitácora inmutable. Devuelve su id. */
export async function registrarEnBitacora(trx: Trx, evento: EventoBitacora): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT bitacora_registrar(
      ${evento.actorTipo}, ${evento.actorId}, ${evento.accion},
      ${evento.entidad ?? null}, ${evento.entidadId ?? null},
      ${JSON.stringify(evento.datos ?? {})}::jsonb,
      ${evento.empresaId ?? null}::uuid, ${evento.enNombreDe ?? null}::uuid
    ) AS id`.execute(trx);
  return String(rows[0]!.id);
}

export async function listarBitacoraEmpresa(trx: Trx, empresaId: string, desdeId: string | null, limite = 100) {
  let consulta = trx
    .selectFrom('bitacora')
    .select(['id', 'ocurrido_en', 'actor_tipo', 'actor_id', 'en_nombre_de', 'accion', 'entidad', 'entidad_id', 'datos'])
    .where('empresa_id', '=', empresaId)
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(limite, 1), 500));
  if (desdeId) {
    consulta = consulta.where('id', '<', desdeId as never);
  }
  return consulta.execute();
}
