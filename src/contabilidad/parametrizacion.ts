import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';

/**
 * Parametrización contable: plan de cuentas base e imputación de cada concepto
 * (clientes, retiros de socios, préstamos por pagar, comisiones bancarias, IVA, PPM...).
 * Los cambios pasan por funciones de la base de datos que validan la clasificación de la
 * cuenta, guardan el historial con motivo y registran en la bitácora.
 */

export interface ImputacionConcepto {
  concepto: string;
  nombre: string;
  descripcion: string;
  clasificaciones: string[];
  cuenta: { codigo: string; nombre: string } | null;
  motivo: string | null;
  actualizado_en: Date | null;
  /** Cuentas imputables y activas de la empresa que el concepto admite. */
  opciones: Array<{ codigo: string; nombre: string; requiere_tercero: boolean }>;
}

export async function listarImputaciones(trx: Trx, empresaId: string): Promise<ImputacionConcepto[]> {
  const { rows } = await sql<{
    concepto: string;
    nombre: string;
    descripcion: string;
    clasificaciones: string[];
    cuenta_codigo: string | null;
    cuenta_nombre: string | null;
    motivo: string | null;
    actualizado_en: Date | null;
    opciones: Array<{ codigo: string; nombre: string; requiere_tercero: boolean }>;
  }>`
    SELECT c.codigo AS concepto, c.nombre, c.descripcion, c.clasificaciones,
           p.codigo AS cuenta_codigo, p.nombre AS cuenta_nombre, i.motivo, i.registrado_en AS actualizado_en,
           coalesce((SELECT jsonb_agg(jsonb_build_object('codigo', o.codigo, 'nombre', o.nombre, 'requiere_tercero', o.requiere_tercero)
                                      ORDER BY o.codigo)
                     FROM plan_cuentas o
                     WHERE o.empresa_id = ${empresaId}::uuid AND contabilidad_cuenta_sirve(c, o)),
                    '[]') AS opciones
    FROM conceptos_imputacion c
    LEFT JOIN imputaciones i ON i.concepto = c.codigo AND i.empresa_id = ${empresaId}::uuid AND i.estado = 'VIGENTE'
    LEFT JOIN plan_cuentas p ON p.id = i.cuenta_contable_id
    ORDER BY c.orden`.execute(trx);
  return rows.map((r) => ({
    concepto: r.concepto,
    nombre: r.nombre,
    descripcion: r.descripcion,
    clasificaciones: r.clasificaciones,
    cuenta: r.cuenta_codigo ? { codigo: r.cuenta_codigo, nombre: r.cuenta_nombre! } : null,
    motivo: r.motivo,
    actualizado_en: r.actualizado_en,
    opciones: r.opciones,
  }));
}

export async function historialImputacion(trx: Trx, empresaId: string, concepto: string) {
  const { rows } = await sql<{ cuenta: string; nombre: string; estado: string; motivo: string; registrado_en: Date; registrado_por: string }>`
    SELECT p.codigo AS cuenta, p.nombre, i.estado, i.motivo, i.registrado_en, u.nombre AS registrado_por
    FROM imputaciones i
    JOIN plan_cuentas p ON p.id = i.cuenta_contable_id
    LEFT JOIN usuarios u ON u.id = i.registrado_por
    WHERE i.empresa_id = ${empresaId}::uuid AND i.concepto = ${concepto}
    ORDER BY i.registrado_en DESC, i.id DESC`.execute(trx);
  return rows;
}

export async function configurarImputacion(trx: Trx, empresaId: string, concepto: string, cuenta: string, motivo: string): Promise<void> {
  await sql`SELECT contabilidad_configurar_imputacion(${empresaId}::uuid, ${concepto}, ${cuenta}, ${motivo})`.execute(trx);
}

export async function cargarPlanBase(
  trx: Trx,
  empresaId: string,
): Promise<{ cuentas_creadas: number; imputaciones_creadas: number; conceptos_sin_configurar: string[] }> {
  const { rows } = await sql<{ r: { cuentas_creadas: number; imputaciones_creadas: number; conceptos_sin_configurar: string[] } }>`
    SELECT contabilidad_cargar_plan_base(${empresaId}::uuid) AS r`.execute(trx);
  return rows[0]!.r;
}
