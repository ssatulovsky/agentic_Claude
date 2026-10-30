import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { noEncontrado } from '../errores.js';

/**
 * Propuesta de F29. El cálculo vive en la base de datos (f29_preparar) para que
 * ninguna cifra pueda escribirse a mano: aquí solo se invoca y se presenta.
 */

/** Descripción breve de los códigos que el sistema calcula o admite como ajuste. */
export const CODIGOS_F29: Record<string, string> = {
  '20': 'Exportaciones (monto)',
  '585': 'Exportaciones (cantidad de documentos)',
  '586': 'Ventas exentas o no gravadas del giro (cantidad)',
  '142': 'Ventas exentas o no gravadas del giro (monto)',
  '503': 'Facturas emitidas (cantidad)',
  '502': 'Facturas emitidas: débito fiscal',
  '763': 'Facturas de venta de inmuebles (cantidad)',
  '764': 'Facturas de venta de inmuebles: débito',
  '716': 'Facturas de ventas que no son del giro (cantidad)',
  '717': 'Facturas de ventas que no son del giro: débito',
  '110': 'Boletas (cantidad)',
  '111': 'Boletas: débito',
  '758': 'Comprobantes de pago electrónico (cantidad)',
  '759': 'Comprobantes de pago electrónico: débito',
  '512': 'Notas de débito emitidas (cantidad)',
  '513': 'Notas de débito emitidas: débito',
  '509': 'Notas de crédito emitidas (cantidad)',
  '510': 'Notas de crédito emitidas: rebaja de débito',
  '733': 'Notas de crédito por ventas que no son del giro (cantidad)',
  '734': 'Notas de crédito por ventas que no son del giro: rebaja',
  '500': 'Liquidaciones-factura (cantidad)',
  '501': 'Liquidaciones-factura: débito',
  '817': 'Liquidaciones-factura emitidas como mandatario (cantidad)',
  '818': 'Liquidaciones-factura emitidas como mandatario: IVA por cuenta de terceros (resta)',
  '538': 'Total débitos',
  '519': 'Facturas recibidas del giro (cantidad)',
  '520': 'Facturas recibidas del giro: crédito',
  '761': 'Facturas de supermercados (cantidad)',
  '762': 'Facturas de supermercados: crédito',
  '765': 'Facturas de construcción o adquisición de inmuebles (cantidad)',
  '766': 'Facturas de construcción o adquisición de inmuebles: crédito',
  '524': 'Facturas de activo fijo (cantidad)',
  '525': 'Facturas de activo fijo: crédito',
  '527': 'Notas de crédito recibidas (cantidad)',
  '528': 'Notas de crédito recibidas: rebaja de crédito',
  '531': 'Notas de débito recibidas (cantidad)',
  '532': 'Notas de débito recibidas: crédito',
  '534': 'Importaciones del giro (cantidad)',
  '535': 'Importaciones del giro: crédito',
  '536': 'Importaciones de activo fijo (cantidad)',
  '553': 'Importaciones de activo fijo: crédito',
  '564': 'Compras afectas sin derecho a crédito (cantidad)',
  '521': 'Compras afectas sin derecho a crédito (monto)',
  '584': 'Compras exentas o no gravadas (cantidad)',
  '562': 'Compras exentas o no gravadas (monto)',
  '504': 'Remanente de crédito fiscal del mes anterior, reajustado',
  '537': 'Total créditos',
  '89': 'IVA determinado',
  '77': 'Remanente de crédito fiscal para el período siguiente',
  '563': 'PPM: base imponible (ingresos brutos)',
  '115': 'PPM: tasa (%)',
  '62': 'PPM determinado',
  '151': 'Retención de honorarios (art. 42 N°2 LIR)',
  '48': 'Impuesto único de segunda categoría',
  '153': 'Retención a directores (10%)',
  '595': 'Subtotal impuesto determinado',
  '91': 'Total a pagar dentro del plazo',
};

export interface AjusteF29 {
  codigo: string;
  monto: number;
  motivo: string;
}

export interface PrepararF29 {
  empresaId: string;
  anio: number;
  mes: number;
  remanenteAnterior?: number | null;
  factorProporcionalidad?: number | null;
  ajustes?: AjusteF29[];
}

export async function prepararF29(trx: Trx, p: PrepararF29): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT f29_preparar(${p.empresaId}::uuid, ${p.anio}::int, ${p.mes}::int,
      ${p.remanenteAnterior ?? null}::numeric, ${p.factorProporcionalidad ?? null}::numeric,
      ${JSON.stringify(p.ajustes ?? [])}::jsonb) AS id`.execute(trx);
  return rows[0]!.id;
}

export async function aprobarF29(trx: Trx, id: string, confirmoAdvertencias: boolean): Promise<void> {
  await sql`SELECT f29_aprobar(${id}::uuid, ${confirmoAdvertencias})`.execute(trx);
}

export async function registrarDeclaracionF29(trx: Trx, id: string, folio: string, fecha: string): Promise<void> {
  await sql`SELECT f29_registrar_declaracion(${id}::uuid, ${folio}, ${fecha}::date)`.execute(trx);
}

export async function anularF29(trx: Trx, id: string, motivo: string): Promise<void> {
  await sql`SELECT f29_anular(${id}::uuid, ${motivo})`.execute(trx);
}

export async function configurarTasaPpm(
  trx: Trx,
  empresaId: string,
  desde: string,
  tasa: number,
  fuente: string,
  motivoReemplazo?: string,
): Promise<void> {
  await sql`SELECT tributario_configurar_ppm(${empresaId}::uuid, ${desde}::date, ${tasa}::numeric, ${fuente}, ${motivoReemplazo ?? null})`.execute(
    trx,
  );
}

interface FilaF29 {
  id: string;
  periodo: string;
  version: number;
  estado: string;
  codigos: Record<string, number>;
  detalle: Record<string, unknown>;
  advertencias: Array<{ tipo: string; mensaje: string; detalle?: unknown }>;
  origen: string;
  preparado_en: Date;
  aprobado_en: Date | null;
  folio_sii: string | null;
  fecha_declaracion: string | null;
  motivo_anulacion: string | null;
}

const columnas = sql`id, to_char(periodo, 'YYYY-MM') AS periodo, version, estado, codigos, detalle, advertencias, origen,
  preparado_en, aprobado_en, folio_sii, to_char(fecha_declaracion, 'YYYY-MM-DD') AS fecha_declaracion, motivo_anulacion`;

/** Presenta los códigos en el orden del formulario, con su descripción. */
export function presentarCodigos(codigos: Record<string, number>) {
  const orden = Object.keys(CODIGOS_F29);
  return Object.entries(codigos)
    .sort(([a], [b]) => {
      const ia = orden.indexOf(a);
      const ib = orden.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || Number(a) - Number(b);
    })
    .map(([codigo, valor]) => ({ codigo, descripcion: CODIGOS_F29[codigo] ?? 'Código del F29', valor: Number(valor) }));
}

export async function obtenerF29(trx: Trx, empresaId: string, id: string) {
  const { rows } = await sql<FilaF29>`
    SELECT ${columnas} FROM f29_declaraciones WHERE id = ${id}::uuid AND empresa_id = ${empresaId}::uuid`.execute(trx);
  const f = rows[0];
  if (!f) throw noEncontrado('El F29');
  return { ...f, lineas: presentarCodigos(f.codigos) };
}

/** Versiones de un período (o de los últimos 24 meses si no se indica). */
export async function listarF29(trx: Trx, empresaId: string, anio?: number, mes?: number) {
  const filtro =
    anio && mes ? sql`AND periodo = make_date(${anio}::int, ${mes}::int, 1)` : sql`AND periodo >= (current_date - interval '24 months')`;
  const { rows } = await sql<FilaF29>`
    SELECT ${columnas} FROM f29_declaraciones
    WHERE empresa_id = ${empresaId}::uuid ${filtro}
    ORDER BY periodo DESC, version DESC`.execute(trx);
  return rows.map((f) => ({
    id: f.id,
    periodo: f.periodo,
    version: f.version,
    estado: f.estado,
    origen: f.origen,
    ivaDeterminado: Number(f.codigos['89'] ?? 0),
    remanente: Number(f.codigos['77'] ?? 0),
    totalAPagar: Number(f.codigos['91'] ?? 0),
    advertencias: f.advertencias.length,
    folioSii: f.folio_sii,
  }));
}

export type RegimenTributario = 'PRO_PYME_TRANSPARENTE' | 'PRO_PYME_GENERAL' | 'SEMI_INTEGRADO' | 'OTRO';

export interface ConfiguracionTributaria {
  empresaId: string;
  /** Primer día del mes desde el que rige. */
  desde: string;
  regimen: RegimenTributario;
  /** La empresa solo tiene operaciones exentas o no gravadas: el IVA de sus compras no es crédito. */
  ivaComprasNoRecuperable: boolean;
  /** Código del SII (1: operaciones exentas o no gravadas). */
  codigoIvaNoRecuperable?: number;
  motivo: string;
}

export async function configurarTributario(trx: Trx, c: ConfiguracionTributaria): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT tributario_configurar(${c.empresaId}::uuid, ${c.desde}::date, ${c.regimen}, ${c.ivaComprasNoRecuperable},
      ${c.codigoIvaNoRecuperable ?? null}::int, ${c.motivo}) AS id`.execute(trx);
  return String(rows[0]!.id);
}
