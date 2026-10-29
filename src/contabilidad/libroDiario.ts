import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { noEncontrado } from '../errores.js';

/**
 * Operaciones del libro diario. Toda escritura pasa por las funciones de la base
 * de datos (contabilidad_*), que validan partida doble, períodos, cuentas y
 * permisos, y registran en la bitácora. Este módulo solo las invoca.
 */

export interface LineaAsiento {
  /** Código de la cuenta imputable, p. ej. "1.1.01". */
  cuenta: string;
  debe?: number | string;
  haber?: number | string;
  /** RUT del tercero (cliente, proveedor, trabajador). */
  tercero?: string;
  /** Código del centro de costo. */
  centroCosto?: string;
  glosa?: string;
}

export interface NuevoAsiento {
  empresaId: string;
  fecha: string;
  glosa: string;
  lineas: LineaAsiento[];
  tipo?: 'NORMAL' | 'APERTURA' | 'AJUSTE';
  documentoReferencia?: string | null;
  origen?: 'MANUAL' | 'AGENTE' | 'MODULO';
  propuestaId?: string | null;
}

const lineasJson = (lineas: LineaAsiento[]) =>
  JSON.stringify(
    lineas.map((l) => ({
      cuenta: l.cuenta,
      debe: l.debe ?? 0,
      haber: l.haber ?? 0,
      tercero: l.tercero ?? null,
      centro_costo: l.centroCosto ?? null,
      glosa: l.glosa ?? null,
    })),
  );

export async function registrarAsiento(trx: Trx, a: NuevoAsiento): Promise<{ id: string; numero: number }> {
  const { rows } = await sql<{ id: string }>`
    SELECT contabilidad_registrar_asiento(
      ${a.empresaId}::uuid, ${a.fecha}::date, ${a.glosa}, ${lineasJson(a.lineas)}::jsonb,
      ${a.tipo ?? 'NORMAL'}, ${a.documentoReferencia ?? null}, ${a.origen ?? 'MANUAL'},
      ${a.propuestaId ?? null}::uuid, NULL
    ) AS id`.execute(trx);
  const id = rows[0]!.id;
  const { numero } = await trx.selectFrom('asientos').select('numero').where('id', '=', id).executeTakeFirstOrThrow();
  return { id, numero };
}

export async function reversarAsiento(trx: Trx, asientoId: string, fecha: string, motivo: string) {
  const { rows } = await sql<{ id: string }>`
    SELECT contabilidad_reversar_asiento(${asientoId}::uuid, ${fecha}::date, ${motivo}) AS id`.execute(trx);
  const id = rows[0]!.id;
  const { numero } = await trx.selectFrom('asientos').select('numero').where('id', '=', id).executeTakeFirstOrThrow();
  return { id, numero };
}

export async function crearEjercicio(trx: Trx, empresaId: string, anio: number, fechaInicio?: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT contabilidad_crear_ejercicio(${empresaId}::uuid, ${anio}::int, ${fechaInicio ?? null}::date) AS id`.execute(trx);
  return rows[0]!.id;
}

export async function cerrarPeriodo(trx: Trx, periodoId: string): Promise<void> {
  await sql`SELECT contabilidad_cerrar_periodo(${periodoId}::uuid)`.execute(trx);
}

export async function reabrirPeriodo(trx: Trx, periodoId: string, motivo: string): Promise<void> {
  await sql`SELECT contabilidad_reabrir_periodo(${periodoId}::uuid, ${motivo})`.execute(trx);
}

export async function cerrarEjercicio(trx: Trx, ejercicioId: string): Promise<void> {
  await sql`SELECT contabilidad_cerrar_ejercicio(${ejercicioId}::uuid)`.execute(trx);
}

export async function solicitarReaperturaEjercicio(
  trx: Trx,
  ejercicioId: string,
  motivo: string,
  actaReferencia: string,
  plazoDias: number,
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT contabilidad_solicitar_reapertura_ejercicio(${ejercicioId}::uuid, ${motivo}, ${actaReferencia}, ${plazoDias}::int) AS id`.execute(
    trx,
  );
  return rows[0]!.id;
}

export async function resolverReaperturaEjercicio(
  trx: Trx,
  solicitudId: string,
  decision: 'APROBAR' | 'RECHAZAR',
  comentario: string | null,
): Promise<string> {
  const { rows } = await sql<{ estado: string }>`
    SELECT contabilidad_resolver_reapertura_ejercicio(${solicitudId}::uuid, ${decision}, ${comentario}) AS estado`.execute(trx);
  return rows[0]!.estado;
}

export async function listarEjercicios(trx: Trx, empresaId: string) {
  const ejercicios = await trx
    .selectFrom('ejercicios_contables')
    .select(['id', 'anio', 'fecha_inicio', 'fecha_termino', 'estado', 'reabierto_hasta', 'ultimo_numero'])
    .where('empresa_id', '=', empresaId)
    .orderBy('anio', 'desc')
    .execute();
  const periodos = await trx
    .selectFrom('periodos_contables')
    .select(['id', 'ejercicio_id', 'anio', 'mes', 'estado', 'cerrado_en'])
    .where('empresa_id', '=', empresaId)
    .orderBy('anio')
    .orderBy('mes')
    .execute();
  return ejercicios.map((e) => ({ ...e, periodos: periodos.filter((p) => p.ejercicio_id === e.id) }));
}

export async function obtenerAsiento(trx: Trx, empresaId: string, asientoId: string) {
  const asiento = await trx
    .selectFrom('asientos')
    .select(['id', 'numero', 'fecha', 'tipo', 'origen', 'glosa', 'documento_referencia', 'reversa_de', 'total', 'registrado_por', 'registrado_en'])
    .where('id', '=', asientoId)
    .where('empresa_id', '=', empresaId)
    .executeTakeFirst();
  if (!asiento) throw noEncontrado('El asiento');
  const lineas = await trx
    .selectFrom('asiento_lineas as l')
    .innerJoin('plan_cuentas as c', 'c.id', 'l.cuenta_id')
    .leftJoin('terceros as t', 't.id', 'l.tercero_id')
    .leftJoin('centros_costo as cc', 'cc.id', 'l.centro_costo_id')
    .select([
      'l.linea',
      'c.codigo as cuenta',
      'c.nombre as nombre_cuenta',
      'l.debe',
      'l.haber',
      't.rut as tercero',
      'cc.codigo as centro_costo',
      'l.glosa',
    ])
    .where('l.asiento_id', '=', asientoId)
    .orderBy('l.linea')
    .execute();
  const reversadoPor = await trx
    .selectFrom('asientos')
    .select(['id', 'numero'])
    .where('reversa_de', '=', asientoId)
    .executeTakeFirst();
  return { ...asiento, lineas, reversado_por: reversadoPor ?? null };
}

export async function listarAsientos(trx: Trx, empresaId: string, desde: string, hasta: string, limite = 200) {
  return trx
    .selectFrom('asientos')
    .select(['id', 'numero', 'fecha', 'tipo', 'origen', 'glosa', 'documento_referencia', 'reversa_de', 'total'])
    .where('empresa_id', '=', empresaId)
    .where('fecha', '>=', desde)
    .where('fecha', '<=', hasta)
    .orderBy('fecha')
    .orderBy('numero')
    .limit(Math.min(Math.max(limite, 1), 1000))
    .execute();
}
