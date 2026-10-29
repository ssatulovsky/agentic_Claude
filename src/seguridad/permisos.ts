import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { sinPermiso } from '../errores.js';

/** Permisos efectivos del usuario de la transacción en una empresa. */
export async function permisosEnEmpresa(trx: Trx, empresaId: string): Promise<Set<string>> {
  const { rows } = await sql<{ permiso: string }>`
    SELECT app_permisos_en_empresa(${empresaId}::uuid) AS permiso`.execute(trx);
  return new Set(rows.map((r) => r.permiso));
}

export async function exigirPermiso(trx: Trx, empresaId: string, permiso: string): Promise<void> {
  const permisos = await permisosEnEmpresa(trx, empresaId);
  if (!permisos.has(permiso)) {
    throw sinPermiso(permiso);
  }
}

export async function tienePermisoCliente(trx: Trx, permiso: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`SELECT app_tiene_permiso_cliente(${permiso}) AS ok`.execute(trx);
  return rows[0]?.ok === true;
}

export async function exigirPermisoCliente(trx: Trx, permiso: string): Promise<void> {
  if (!(await tienePermisoCliente(trx, permiso))) {
    throw sinPermiso(permiso);
  }
}

/** ¿La empresa tiene el módulo contratado y vigente en la fecha indicada? */
export async function moduloVigente(trx: Trx, empresaId: string, modulo: string, fecha: string): Promise<boolean> {
  const fila = await trx
    .selectFrom('suscripciones_modulo')
    .select('id')
    .where('empresa_id', '=', empresaId)
    .where('modulo_codigo', '=', modulo)
    .where('vigente_desde', '<=', fecha)
    .where((eb) => eb.or([eb('vigente_hasta', 'is', null), eb('vigente_hasta', '>', fecha)]))
    .executeTakeFirst();
  return fila !== undefined;
}
