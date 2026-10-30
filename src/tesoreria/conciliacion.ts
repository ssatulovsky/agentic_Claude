import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { registrarAsiento } from '../contabilidad/libroDiario.js';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio, noEncontrado } from '../errores.js';
import { exigirPermiso } from '../seguridad/permisos.js';
import { leerCartola } from './cartola.js';

/**
 * Tesorería: cuentas bancarias, cartolas y conciliación. Toda escritura pasa por las
 * funciones tesoreria_* de la base de datos, que validan permisos, módulo, cuadratura e
 * inmutabilidad y registran en la bitácora. Las sugerencias y el informe solo leen.
 */

export type Banco = 'SCOTIABANK' | 'BANCO_ESTADO' | 'BANCO_CHILE' | 'BCI' | 'SANTANDER' | 'ITAU' | 'BICE' | 'SECURITY' | 'FALABELLA' | 'OTRO';

const n = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

export async function crearCuentaBancaria(
  trx: Trx,
  c: { empresaId: string; banco: Banco; numero: string; cuentaContable: string },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT tesoreria_crear_cuenta(${c.empresaId}::uuid, ${c.banco}, ${c.numero}, ${c.cuentaContable}) AS id`.execute(trx);
  return rows[0]!.id;
}

export async function listarCuentasBancarias(trx: Trx, empresaId: string) {
  const { rows } = await sql<{ id: string; banco: Banco; numero: string; moneda: string; cuenta_contable: string; activa: boolean }>`
    SELECT b.id, b.banco, b.numero, b.moneda, p.codigo AS cuenta_contable, b.activa
    FROM cuentas_bancarias b JOIN plan_cuentas p ON p.id = b.cuenta_contable_id
    WHERE b.empresa_id = ${empresaId}::uuid ORDER BY b.banco, b.numero`.execute(trx);
  return rows;
}

async function cuentaBancaria(trx: Trx, empresaId: string, cuentaId: string) {
  const { rows } = await sql<{ id: string; banco: Banco; numero: string; cuenta_contable_id: string; cuenta_contable: string }>`
    SELECT b.id, b.banco, b.numero, b.cuenta_contable_id, p.codigo AS cuenta_contable
    FROM cuentas_bancarias b JOIN plan_cuentas p ON p.id = b.cuenta_contable_id
    WHERE b.id = ${cuentaId}::uuid AND b.empresa_id = ${empresaId}::uuid`.execute(trx);
  const c = rows[0];
  if (!c) throw noEncontrado('La cuenta bancaria');
  return c;
}

export async function importarCartola(
  trx: Trx,
  i: { empresaId: string; cuentaId: string; archivoNombre: string; contenido: Buffer },
) {
  // El permiso se verifica antes de leer el archivo.
  await exigirPermiso(trx, i.empresaId, 'tesoreria.cartolas.importar');
  const cuenta = await cuentaBancaria(trx, i.empresaId, i.cuentaId);
  const cartola = leerCartola(i.contenido);
  if (cartola.cabecera.numero_cuenta && cartola.cabecera.numero_cuenta !== cuenta.numero) {
    throw new ErrorNegocio(
      'CARTOLA_OTRA_CUENTA',
      `La cartola es de la cuenta ${cartola.cabecera.numero_cuenta} y se está importando en la cuenta ${cuenta.numero}.`,
      422,
    );
  }
  const sha256 = createHash('sha256').update(i.contenido).digest('hex');
  const { rows } = await sql<{ r: { cartola_id: string; movimientos?: number; nuevos: number; ya_importada: boolean; advertencias: unknown[] } }>`
    SELECT tesoreria_registrar_cartola(${i.empresaId}::uuid, ${i.cuentaId}::uuid, ${cartola.formato}, ${i.archivoNombre},
      ${sha256}, ${JSON.stringify(cartola.cabecera)}::jsonb, ${JSON.stringify(cartola.movimientos)}::jsonb) AS r`.execute(trx);
  return { ...rows[0]!.r, cabecera: cartola.cabecera, formato: cartola.formato };
}

export interface MovimientoBanco {
  id: number;
  fecha: string;
  descripcion: string;
  numero_documento: string | null;
  monto: number;
  saldo: number | null;
  rut_contraparte: string | null;
  conciliacion_id: string | null;
}

export async function listarMovimientos(
  trx: Trx,
  empresaId: string,
  cuentaId: string,
  filtro: { desde?: string; hasta?: string; soloPendientes?: boolean } = {},
): Promise<MovimientoBanco[]> {
  const { rows } = await sql<MovimientoBanco & { monto: string; saldo: string | null; id: string }>`
    SELECT m.id, to_char(m.fecha, 'YYYY-MM-DD') AS fecha, m.descripcion, m.numero_documento, m.monto, m.saldo,
           m.rut_contraparte, cm.conciliacion_id
    FROM movimientos_bancarios m
    LEFT JOIN conciliacion_movimientos cm ON cm.movimiento_id = m.id AND cm.vigente
    WHERE m.empresa_id = ${empresaId}::uuid AND m.cuenta_id = ${cuentaId}::uuid
      AND (${filtro.desde ?? null}::date IS NULL OR m.fecha >= ${filtro.desde ?? null}::date)
      AND (${filtro.hasta ?? null}::date IS NULL OR m.fecha <= ${filtro.hasta ?? null}::date)
      AND (${filtro.soloPendientes ?? false} = false OR cm.conciliacion_id IS NULL)
    ORDER BY m.fecha, m.id`.execute(trx);
  return rows.map((r) => ({ ...r, id: Number(r.id), monto: n(r.monto), saldo: r.saldo === null ? null : n(r.saldo) }));
}

export interface LineaBanco {
  linea_id: number;
  asiento_id: string;
  numero: number;
  fecha: string;
  tipo: string;
  glosa: string;
  monto: number;
  tercero: string | null;
  anulada: boolean;
  conciliacion_id: string | null;
}

export async function lineasBanco(trx: Trx, empresaId: string, cuentaId: string, hasta: string): Promise<LineaBanco[]> {
  const { rows } = await sql<LineaBanco & { linea_id: string; monto: string }>`
    SELECT linea_id, asiento_id, numero, to_char(fecha, 'YYYY-MM-DD') AS fecha, tipo, glosa, monto, tercero, anulada, conciliacion_id
    FROM tesoreria_lineas_banco(${empresaId}::uuid, ${cuentaId}::uuid, ${hasta}::date)`.execute(trx);
  return rows.map((r) => ({ ...r, linea_id: Number(r.linea_id), monto: n(r.monto) }));
}

export async function conciliar(trx: Trx, empresaId: string, movimientos: number[], lineas: number[]): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT tesoreria_conciliar(${empresaId}::uuid, ${movimientos}::bigint[], ${lineas}::bigint[]) AS id`.execute(trx);
  return rows[0]!.id;
}

export async function anularConciliacion(trx: Trx, id: string, motivo: string): Promise<void> {
  await sql`SELECT tesoreria_anular_conciliacion(${id}::uuid, ${motivo})`.execute(trx);
}

/**
 * Registra el asiento de un movimiento del banco (banco contra la cuenta indicada) y lo
 * concilia en la misma transacción. El asiento pasa por todas las validaciones del libro
 * diario (período abierto, cuentas imputables, tercero cuando la cuenta lo exige).
 */
export async function contabilizarMovimiento(
  trx: Trx,
  c: { empresaId: string; movimientoId: number; cuentaContable: string; tercero?: string; centroCosto?: string; glosa: string; propuestaId?: string },
): Promise<{ asientoId: string; numero: number; conciliacionId: string }> {
  await exigirPermiso(trx, c.empresaId, 'tesoreria.conciliar');
  const { rows } = await sql<{ cuenta_id: string; fecha: string; monto: string; descripcion: string; conciliado: boolean }>`
    SELECT m.cuenta_id, to_char(m.fecha, 'YYYY-MM-DD') AS fecha, m.monto, m.descripcion,
           EXISTS (SELECT 1 FROM conciliacion_movimientos cm WHERE cm.movimiento_id = m.id AND cm.vigente) AS conciliado
    FROM movimientos_bancarios m WHERE m.id = ${c.movimientoId} AND m.empresa_id = ${c.empresaId}::uuid`.execute(trx);
  const mov = rows[0];
  if (!mov) throw noEncontrado('El movimiento');
  if (mov.conciliado) throw new ErrorNegocio('YA_CONCILIADO', 'El movimiento ya está conciliado.', 409);
  const cuenta = await cuentaBancaria(trx, c.empresaId, mov.cuenta_id);
  if (c.cuentaContable === cuenta.cuenta_contable) {
    throw new ErrorNegocio('CUENTA_INVALIDA', 'La contrapartida no puede ser la misma cuenta del banco.', 422);
  }
  const monto = Math.abs(n(mov.monto));
  const abono = n(mov.monto) > 0;
  const banco = { cuenta: cuenta.cuenta_contable, ...(abono ? { debe: monto } : { haber: monto }) };
  const contra = {
    cuenta: c.cuentaContable,
    ...(abono ? { haber: monto } : { debe: monto }),
    ...(c.tercero ? { tercero: c.tercero } : {}),
    ...(c.centroCosto ? { centroCosto: c.centroCosto } : {}),
  };
  if (c.propuestaId) await sql`SELECT set_config('app.propuesta_agente', ${c.propuestaId}, true)`.execute(trx);
  const asiento = await registrarAsiento(trx, {
    empresaId: c.empresaId,
    fecha: mov.fecha,
    glosa: c.glosa,
    documentoReferencia: `Cartola ${cuenta.banco} ${cuenta.numero}: ${mov.descripcion}`.slice(0, 100),
    lineas: [banco, contra],
    // Si viene de una propuesta del agente, la registra la persona que la aprueba (origen
    // MANUAL); la conciliación queda con origen AGENTE_APROBADO y la propuesta guarda el asiento.
  });
  const linea = (await lineasBanco(trx, c.empresaId, mov.cuenta_id, mov.fecha)).find((l) => l.asiento_id === asiento.id);
  if (!linea) throw new ErrorNegocio('ERROR_INTERNO', 'No se encontró la línea del banco del asiento registrado.', 500);
  const conciliacionId = await conciliar(trx, c.empresaId, [c.movimientoId], [linea.linea_id]);
  return { asientoId: asiento.id, numero: asiento.numero, conciliacionId };
}

// ---------------------------------------------------------------------------
// Reglas de clasificación
// ---------------------------------------------------------------------------
export interface NuevaRegla {
  empresaId: string;
  cuentaId?: string;
  nombre: string;
  rut?: string;
  texto?: string;
  sentido: 'ABONO' | 'CARGO' | 'AMBOS';
  cuentaContable: string;
  tercero?: string;
  glosa: string;
}

export async function crearRegla(trx: Trx, r: NuevaRegla): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT tesoreria_crear_regla(${r.empresaId}::uuid, ${r.cuentaId ?? null}::uuid, ${r.nombre}, ${r.rut ?? null}, ${r.texto ?? null},
      ${r.sentido}, ${r.cuentaContable}, ${r.tercero ?? null}, ${r.glosa}) AS id`.execute(trx);
  return rows[0]!.id;
}

export async function desactivarRegla(trx: Trx, id: string): Promise<void> {
  await sql`SELECT tesoreria_desactivar_regla(${id}::uuid)`.execute(trx);
}

interface Regla {
  id: string;
  cuenta_id: string | null;
  nombre: string;
  rut_contraparte: string | null;
  texto: string | null;
  sentido: 'ABONO' | 'CARGO' | 'AMBOS';
  cuenta_contable: string;
  tercero: string | null;
  glosa: string;
}

export async function listarReglas(trx: Trx, empresaId: string): Promise<Regla[]> {
  const { rows } = await sql<Regla>`
    SELECT r.id, r.cuenta_id, r.nombre, r.rut_contraparte, r.texto, r.sentido, p.codigo AS cuenta_contable, t.rut AS tercero, r.glosa
    FROM reglas_conciliacion r
    JOIN plan_cuentas p ON p.id = r.cuenta_contable_id
    LEFT JOIN terceros t ON t.id = r.tercero_id
    WHERE r.empresa_id = ${empresaId}::uuid AND r.activa
    ORDER BY r.nombre`.execute(trx);
  return rows;
}

// ---------------------------------------------------------------------------
// Sugerencias
// ---------------------------------------------------------------------------
const DIAS_TOLERANCIA = 7;
const dias = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export type Sugerencia =
  | { movimientoId: number; tipo: 'CONCILIAR'; lineas: number[]; confianza: 'ALTA' | 'MEDIA'; motivo: string }
  | {
      movimientoId: number;
      tipo: 'CONTABILIZAR';
      regla: { id: string; nombre: string; cuentaContable: string; tercero: string | null; glosa: string };
      motivo: string;
    }
  | { movimientoId: number; tipo: 'SIN_SUGERENCIA'; motivo: string };

export interface EvidenciaDocumento {
  libro: 'VENTA' | 'COMPRA';
  tipo_documento: number;
  folio: number;
  fecha: string;
  monto_total: number;
}

/**
 * Para cada movimiento pendiente propone: conciliarlo con una línea contable del mismo
 * monto (±7 días), o contabilizarlo según una regla de clasificación. Como evidencia,
 * informa los documentos del RCV de la misma contraparte y monto. No escribe nada.
 */
export async function sugerirConciliacion(trx: Trx, empresaId: string, cuentaId: string, hasta: string) {
  await exigirPermiso(trx, empresaId, 'tesoreria.saldos.ver');
  const cuenta = await cuentaBancaria(trx, empresaId, cuentaId);
  const movimientos = await listarMovimientos(trx, empresaId, cuentaId, { hasta, soloPendientes: true });
  const lineas = (await lineasBanco(trx, empresaId, cuentaId, addDias(hasta, DIAS_TOLERANCIA))).filter(
    (l) => !l.anulada && !l.conciliacion_id && l.tipo !== 'APERTURA' && l.tipo !== 'CIERRE',
  );
  const reglas = (await listarReglas(trx, empresaId)).filter((r) => r.cuenta_id === null || r.cuenta_id === cuenta.id);
  const usadas = new Set<number>();
  const sugerencias: Array<Sugerencia & { evidencia: EvidenciaDocumento[] }> = [];

  for (const m of movimientos) {
    const evidencia = m.rut_contraparte ? await documentosRcv(trx, empresaId, m.rut_contraparte, Math.abs(m.monto), m.monto > 0) : [];
    const candidatas = lineas
      .filter((l) => !usadas.has(l.linea_id) && l.monto === m.monto && dias(l.fecha, m.fecha) <= DIAS_TOLERANCIA)
      .sort((a, b) => dias(a.fecha, m.fecha) - dias(b.fecha, m.fecha));
    if (candidatas.length > 0) {
      const l = candidatas[0]!;
      usadas.add(l.linea_id);
      const unica = candidatas.length === 1;
      sugerencias.push({
        movimientoId: m.id,
        tipo: 'CONCILIAR',
        lineas: [l.linea_id],
        confianza: unica && l.fecha === m.fecha ? 'ALTA' : 'MEDIA',
        motivo: `Asiento N°${l.numero} del ${l.fecha} por el mismo monto${unica ? '' : ` (hay ${candidatas.length} candidatos)`}.`,
        evidencia,
      });
      continue;
    }
    const sentido = m.monto > 0 ? 'ABONO' : 'CARGO';
    const descripcion = m.descripcion.toLowerCase();
    const regla = reglas.find(
      (r) =>
        (r.sentido === 'AMBOS' || r.sentido === sentido) &&
        (r.rut_contraparte ? r.rut_contraparte === m.rut_contraparte : true) &&
        (r.texto ? descripcion.includes(r.texto.toLowerCase()) : true),
    );
    if (regla) {
      sugerencias.push({
        movimientoId: m.id,
        tipo: 'CONTABILIZAR',
        regla: { id: regla.id, nombre: regla.nombre, cuentaContable: regla.cuenta_contable, tercero: regla.tercero, glosa: regla.glosa },
        motivo: `Regla "${regla.nombre}".`,
        evidencia,
      });
      continue;
    }
    sugerencias.push({
      movimientoId: m.id,
      tipo: 'SIN_SUGERENCIA',
      motivo:
        evidencia.length > 0
          ? 'No hay asiento ni regla; hay documentos del RCV de la misma contraparte y monto.'
          : 'No hay asiento del mismo monto ni una regla que aplique: hay que clasificarlo.',
      evidencia,
    });
  }
  return { cuenta: { id: cuenta.id, banco: cuenta.banco, numero: cuenta.numero }, hasta, movimientos, sugerencias };
}

function addDias(fecha: string, d: number): string {
  return new Date(Date.parse(fecha) + d * 86_400_000).toISOString().slice(0, 10);
}

async function documentosRcv(trx: Trx, empresaId: string, rut: string, monto: number, venta: boolean): Promise<EvidenciaDocumento[]> {
  const { rows } = await sql<EvidenciaDocumento & { monto_total: string }>`
    SELECT i.libro, d.tipo_documento, d.folio, to_char(d.fecha_documento, 'YYYY-MM-DD') AS fecha, d.monto_total
    FROM rcv_documentos d JOIN rcv_importaciones i ON i.id = d.importacion_id
    WHERE d.empresa_id = ${empresaId}::uuid AND i.estado = 'VIGENTE' AND i.seccion = 'REGISTRO'
      AND i.libro = ${venta ? 'VENTA' : 'COMPRA'} AND d.rut_contraparte = ${rut} AND d.monto_total = ${monto}
      AND d.tipo_documento NOT IN (60, 61, 112)
    ORDER BY d.fecha_documento DESC LIMIT 5`.execute(trx);
  return rows.map((r) => ({ ...r, folio: Number(r.folio), monto_total: n(r.monto_total) }));
}

// ---------------------------------------------------------------------------
// Informe de conciliación
// ---------------------------------------------------------------------------
export async function informeConciliacion(trx: Trx, empresaId: string, cuentaId: string, corte: string) {
  await exigirPermiso(trx, empresaId, 'tesoreria.saldos.ver');
  const cuenta = await cuentaBancaria(trx, empresaId, cuentaId);
  const { rows: cartolas } = await sql<{ desde: string; hasta: string; saldo_anterior: string; saldo_final: string }>`
    SELECT to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta, saldo_anterior, saldo_final
    FROM cartolas WHERE cuenta_id = ${cuentaId}::uuid AND empresa_id = ${empresaId}::uuid ORDER BY desde, hasta`.execute(trx);
  if (cartolas.length === 0) throw new ErrorNegocio('SIN_CARTOLAS', 'La cuenta no tiene cartolas importadas.', 422);
  const inicio = cartolas[0]!.desde;
  if (corte < inicio) throw new ErrorNegocio('FECHA_INVALIDA', `La conciliación empieza el ${inicio}, con la primera cartola.`, 422);

  const advertencias: string[] = [];
  let cubierto = cartolas[0]!.hasta;
  for (const c of cartolas.slice(1)) {
    if (addDias(cubierto, 1) < c.desde) advertencias.push(`Faltan cartolas entre el ${cubierto} y el ${c.desde}: el saldo del banco no es confiable.`);
    if (c.hasta > cubierto) cubierto = c.hasta;
  }
  if (cubierto < corte) advertencias.push(`Las cartolas llegan hasta el ${cubierto}: los movimientos posteriores no están importados.`);

  const movimientos = await listarMovimientos(trx, empresaId, cuentaId, { hasta: corte });
  const saldoBanco = n(cartolas[0]!.saldo_anterior) + movimientos.reduce((s, m) => s + m.monto, 0);

  const { rows: ej } = await sql<{ fecha_inicio: string }>`
    SELECT to_char(fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio FROM ejercicios_contables
    WHERE empresa_id = ${empresaId}::uuid AND ${corte}::date BETWEEN fecha_inicio AND fecha_termino`.execute(trx);
  if (!ej[0]) throw new ErrorNegocio('SIN_EJERCICIO', 'No hay un ejercicio contable para la fecha de corte.', 422);
  const lineas = await lineasBanco(trx, empresaId, cuentaId, corte);
  // Saldo en libros: movimientos del ejercicio de la fecha de corte (incluye su apertura).
  const saldoLibros = lineas.filter((l) => l.fecha >= ej[0]!.fecha_inicio).reduce((s, l) => s + l.monto, 0);

  const pendientesBanco = movimientos.filter((m) => !m.conciliacion_id);
  const pendientesLibros = lineas.filter(
    (l) => !l.conciliacion_id && !l.anulada && l.tipo !== 'APERTURA' && l.tipo !== 'CIERRE' && l.fecha >= inicio,
  );
  const conAsientoReversado = lineas.filter((l) => l.anulada && l.conciliacion_id);
  if (conAsientoReversado.length > 0) {
    advertencias.push(
      `${conAsientoReversado.length} conciliación(es) tienen un asiento que después se reversó: anúlelas y vuelva a conciliar.`,
    );
  }
  const sumaBanco = pendientesBanco.reduce((s, m) => s + m.monto, 0);
  const sumaLibros = pendientesLibros.reduce((s, l) => s + l.monto, 0);
  const saldoConciliado = saldoLibros + sumaBanco - sumaLibros;
  return {
    cuenta: { id: cuenta.id, banco: cuenta.banco, numero: cuenta.numero, cuentaContable: cuenta.cuenta_contable },
    corte,
    inicio,
    saldoBanco,
    saldoLibros,
    movimientosNoContabilizados: pendientesBanco,
    partidasNoCobradasEnBanco: pendientesLibros,
    saldoConciliado,
    diferencia: saldoBanco - saldoConciliado,
    cuadra: saldoBanco === saldoConciliado && advertencias.length === 0,
    advertencias,
  };
}
