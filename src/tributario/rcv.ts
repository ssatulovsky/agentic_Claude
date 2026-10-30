import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { leerRcvCsv, type Libro } from './rcvCsv.js';

/**
 * Importación del Registro de Compras y Ventas. El archivo se lee aquí y se
 * registra con rcv_registrar_importacion(), que valida permisos, módulo,
 * período y montos, reemplaza la importación anterior y deja todo en la bitácora.
 */

export type Seccion = 'REGISTRO' | 'PENDIENTE' | 'NO_INCLUIR' | 'RECLAMADO';

export interface ImportacionRcv {
  empresaId: string;
  libro: Libro;
  seccion?: Seccion;
  anio: number;
  mes: number;
  archivoNombre: string;
  contenido: string;
  origen?: 'ARCHIVO_SII' | 'ROBOT_SII';
}

export async function importarRcv(trx: Trx, i: ImportacionRcv) {
  const lectura = leerRcvCsv(i.contenido, i.libro);
  const sha256 = createHash('sha256').update(i.contenido, 'utf8').digest('hex');
  const { rows } = await sql<{ id: string }>`
    SELECT rcv_registrar_importacion(
      ${i.empresaId}::uuid, ${i.libro}, ${i.seccion ?? 'REGISTRO'}, ${i.anio}::int, ${i.mes}::int,
      ${i.origen ?? 'ARCHIVO_SII'}, ${i.archivoNombre}, ${sha256}, ${JSON.stringify(lectura.documentos)}::jsonb
    ) AS id`.execute(trx);
  const importacionId = rows[0]!.id;
  const resumen = await sql<{
    cantidad_documentos: number;
    total_exento: string;
    total_neto: string;
    total_iva: string;
    total_general: string;
    importado_en: Date;
  }>`
    SELECT cantidad_documentos, total_exento, total_neto, total_iva, total_general, importado_en
    FROM rcv_importaciones WHERE id = ${importacionId}::uuid`.execute(trx);
  return {
    importacionId,
    ...resumen.rows[0]!,
    columnasNoReconocidas: lectura.columnasNoReconocidas,
  };
}

/** Importaciones vigentes de un período, con su resumen por tipo de documento. */
export async function resumenRcv(trx: Trx, empresaId: string, anio: number, mes: number) {
  const periodo = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const { rows } = await sql<{
    id: string;
    libro: Libro;
    seccion: Seccion;
    archivo_nombre: string;
    importado_en: Date;
    cantidad_documentos: number;
    total_exento: string;
    total_neto: string;
    total_iva: string;
    total_general: string;
    por_tipo: Array<{ tipo_documento: number; tipo_operacion: string; documentos: number; exento: number; neto: number; iva: number; total: number }>;
  }>`
    SELECT i.id, i.libro, i.seccion, i.archivo_nombre, i.importado_en, i.cantidad_documentos,
           i.total_exento, i.total_neto, i.total_iva, i.total_general,
           coalesce((SELECT jsonb_agg(t ORDER BY t.tipo_documento, t.tipo_operacion) FROM (
             SELECT d.tipo_documento, d.tipo_operacion, sum(d.cantidad)::int AS documentos,
                    sum(d.monto_exento) AS exento, sum(d.monto_neto) AS neto, sum(d.monto_iva) AS iva, sum(d.monto_total) AS total
             FROM rcv_documentos d WHERE d.importacion_id = i.id
             GROUP BY d.tipo_documento, d.tipo_operacion) t), '[]') AS por_tipo
    FROM rcv_importaciones i
    WHERE i.empresa_id = ${empresaId}::uuid AND i.periodo = ${periodo}::date AND i.estado = 'VIGENTE'
    ORDER BY i.libro, i.seccion`.execute(trx);
  return { periodo: periodo.slice(0, 7), importaciones: rows };
}
