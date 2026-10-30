import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';

/**
 * Reporte de consumo de IA por Cliente ERP: llamadas, tokens y costo, por empresa, agente
 * y modelo. El costo se calcula al registrar cada llamada con el precio vigente; si no había
 * precio, la llamada se cuenta aparte ("sin precio") y no se supone un valor. El costo en
 * pesos usa el dólar observado del día de la llamada (o del último día hábil anterior).
 */
export interface FilaUso {
  empresa_id: string;
  empresa: string;
  agente: string;
  modelo: string;
  local: boolean;
  llamadas: number;
  fallidas: number;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number;
  costo_clp: number | null;
  llamadas_sin_precio: number;
  llamadas_sin_dolar: number;
}

export async function reporteUso(trx: Trx, filtro: { desde: string; hasta: string; empresaId?: string }) {
  const { rows } = await sql<Record<string, string | boolean>>`
    WITH u AS (
      SELECT x.*, (x.creado_en AT TIME ZONE 'America/Santiago')::date AS dia
      FROM uso_ia x
      WHERE (x.creado_en AT TIME ZONE 'America/Santiago')::date BETWEEN ${filtro.desde}::date AND ${filtro.hasta}::date
        AND (${filtro.empresaId ?? null}::uuid IS NULL OR x.empresa_id = ${filtro.empresaId ?? null}::uuid)
    ), con_dolar AS (
      SELECT u.*, (SELECT d.valor FROM indicadores_economicos d
                   WHERE d.tipo = 'DOLAR' AND d.fecha <= u.dia AND d.fecha > u.dia - 10
                   ORDER BY d.fecha DESC LIMIT 1) AS dolar
      FROM u
    )
    SELECT c.empresa_id, e.razon_social AS empresa, c.agente_codigo AS agente, c.modelo, m.local,
           count(*)::int AS llamadas, count(*) FILTER (WHERE NOT c.exito)::int AS fallidas,
           sum(c.tokens_entrada)::bigint AS tokens_entrada, sum(c.tokens_salida)::bigint AS tokens_salida,
           coalesce(sum(c.costo_usd), 0)::text AS costo_usd,
           CASE WHEN bool_and(c.costo_usd IS NULL OR c.costo_usd = 0 OR c.dolar IS NOT NULL)
                THEN round(coalesce(sum(c.costo_usd * c.dolar), 0), 0)::text END AS costo_clp,
           count(*) FILTER (WHERE c.costo_usd IS NULL AND c.exito)::int AS llamadas_sin_precio,
           count(*) FILTER (WHERE c.costo_usd > 0 AND c.dolar IS NULL)::int AS llamadas_sin_dolar
    FROM con_dolar c
    JOIN empresas e ON e.id = c.empresa_id
    JOIN modelos_ia m ON m.codigo = c.modelo
    GROUP BY c.empresa_id, e.razon_social, c.agente_codigo, c.modelo, m.local
    ORDER BY e.razon_social, c.agente_codigo, c.modelo`.execute(trx);
  const filas: FilaUso[] = rows.map((r) => ({
    empresa_id: String(r.empresa_id),
    empresa: String(r.empresa),
    agente: String(r.agente),
    modelo: String(r.modelo),
    local: r.local === true,
    llamadas: Number(r.llamadas),
    fallidas: Number(r.fallidas),
    tokens_entrada: Number(r.tokens_entrada),
    tokens_salida: Number(r.tokens_salida),
    costo_usd: Number(r.costo_usd),
    costo_clp: r.costo_clp === null ? null : Number(r.costo_clp),
    llamadas_sin_precio: Number(r.llamadas_sin_precio),
    llamadas_sin_dolar: Number(r.llamadas_sin_dolar),
  }));
  const total = filas.reduce(
    (t, f) => ({
      llamadas: t.llamadas + f.llamadas,
      tokens_entrada: t.tokens_entrada + f.tokens_entrada,
      tokens_salida: t.tokens_salida + f.tokens_salida,
      costo_usd: t.costo_usd + f.costo_usd,
      costo_clp: t.costo_clp === null || f.costo_clp === null ? null : t.costo_clp + f.costo_clp,
    }),
    { llamadas: 0, tokens_entrada: 0, tokens_salida: 0, costo_usd: 0, costo_clp: 0 as number | null },
  );
  const advertencias: string[] = [];
  const sinPrecio = filas.reduce((s, f) => s + f.llamadas_sin_precio, 0);
  if (sinPrecio > 0) advertencias.push(`${sinPrecio} llamada(s) a modelos sin precio cargado: su costo no está incluido.`);
  const sinDolar = filas.reduce((s, f) => s + f.llamadas_sin_dolar, 0);
  if (sinDolar > 0) advertencias.push(`${sinDolar} llamada(s) sin dólar observado del día: el total en pesos no se puede calcular.`);
  return { desde: filtro.desde, hasta: filtro.hasta, filas, total, advertencias };
}

export async function estadoCupo(trx: Trx, empresaId: string) {
  const { rows } = await sql<{ usd_mensual: string | null; al_exceder: string | null; usado_usd: string | null; excedido: boolean | null }>`
    SELECT * FROM ia_estado_cupo(${empresaId}::uuid)`.execute(trx);
  const r = rows[0];
  return r && r.usd_mensual !== null
    ? { usdMensual: Number(r.usd_mensual), alExceder: r.al_exceder, usadoUsd: Number(r.usado_usd), excedido: r.excedido === true }
    : null;
}

export async function modelosConPrecio(trx: Trx) {
  const { rows } = await sql<{
    codigo: string;
    proveedor: string;
    local: boolean;
    descripcion: string;
    usd_por_millon_entrada: string | null;
    usd_por_millon_salida: string | null;
    fuente: string | null;
  }>`
    SELECT m.codigo, m.proveedor, m.local, m.descripcion, p.usd_por_millon_entrada, p.usd_por_millon_salida, p.fuente
    FROM modelos_ia m
    LEFT JOIN precios_modelos_ia p ON p.modelo = m.codigo AND daterange(p.vigente_desde, p.vigente_hasta, '[)') @> contabilidad_hoy()
    WHERE m.activo ORDER BY m.local DESC, m.codigo`.execute(trx);
  return rows.map((r) => ({
    ...r,
    usd_por_millon_entrada: r.usd_por_millon_entrada === null ? null : Number(r.usd_por_millon_entrada),
    usd_por_millon_salida: r.usd_por_millon_salida === null ? null : Number(r.usd_por_millon_salida),
  }));
}

export async function politicasEfectivas(trx: Trx, empresaId: string, agentes: string[]) {
  const resultado: Array<{ agente: string; nivel: string; especifica: boolean; cadena: string[] }> = [];
  for (const agente of agentes) {
    const { rows } = await sql<{ nivel: string; agente_codigo: string | null; cadena: string[] }>`
      SELECT nivel, agente_codigo, cadena FROM ia_politica_vigente(${empresaId}::uuid, ${agente})`.execute(trx);
    if (rows[0]) resultado.push({ agente, nivel: rows[0].nivel, especifica: rows[0].agente_codigo !== null, cadena: rows[0].cadena });
  }
  return resultado;
}

export async function configurarPolitica(trx: Trx, p: { empresaId: string | null; agente: string | null; cadena: string[]; motivo: string }) {
  const { rows } = await sql<{ id: string }>`
    SELECT ia_configurar_politica(${p.empresaId}::uuid, ${p.agente}, ${p.cadena}::text[], ${p.motivo}) AS id`.execute(trx);
  return String(rows[0]!.id);
}
