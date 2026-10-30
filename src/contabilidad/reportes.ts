import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio, noEncontrado } from '../errores.js';
import { aCentavos, deCentavos, maxCentavos } from '../utilidades/montos.js';

/**
 * Reportes contables calculados desde los asientos (nunca desde saldos guardados).
 * Reglas:
 *   * Un reporte cubre un solo ejercicio y acumula desde su inicio (incluye el
 *     asiento de apertura), así los saldos son siempre los reales.
 *   * Los asientos de CIERRE (y sus reversas) no se incluyen: el balance muestra
 *     el resultado antes de su traspaso a patrimonio.
 *   * Solo se ven las líneas que el usuario puede ver (seguridad por fila).
 */

const CUENTAS_DE_RESULTADO = new Set(['INGRESO', 'GASTO']);

/** Excluye el asiento de cierre y sus reversas (requiere el alias "a" y "o" = asiento reversado). */
const sinCierre = sql`a.tipo <> 'CIERRE' AND (o.id IS NULL OR o.tipo <> 'CIERRE')`;

async function ejercicioDe(trx: Trx, empresaId: string, fecha: string) {
  const ejercicio = await trx
    .selectFrom('ejercicios_contables')
    .select(['id', 'anio', 'fecha_inicio', 'fecha_termino'])
    .where('empresa_id', '=', empresaId)
    .where('fecha_inicio', '<=', fecha)
    .where('fecha_termino', '>=', fecha)
    .executeTakeFirst();
  if (!ejercicio) {
    throw new ErrorNegocio('SIN_EJERCICIO', `No existe un ejercicio contable que contenga el ${fecha}.`, 422);
  }
  return ejercicio;
}

type Columnas = 'debitos' | 'creditos' | 'saldoDeudor' | 'saldoAcreedor' | 'activo' | 'pasivo' | 'perdida' | 'ganancia';
export type FilaBalance = { codigo: string; nombre: string; clasificacion: string } & Record<Columnas, string>;

export interface BalanceOchoColumnas {
  ejercicio: number;
  desde: string;
  hasta: string;
  filas: FilaBalance[];
  sumas: Record<Columnas, string>;
  /** Positivo = utilidad; negativo = pérdida. */
  resultadoEjercicio: string;
  /** Totales luego de agregar el resultado en la columna que corresponde. */
  totales: Record<Columnas, string>;
  /** Cuentas de orden: se informan aparte y no afectan el inventario. */
  cuentasDeOrden: { codigo: string; nombre: string; saldoDeudor: string; saldoAcreedor: string }[];
  cuadrado: boolean;
}

/**
 * Balance de comprobación y saldos (8 columnas) acumulado del ejercicio hasta
 * una fecha: débitos, créditos, saldos deudor y acreedor, inventario (activo,
 * pasivo) y resultados (pérdida, ganancia).
 */
export async function balanceOchoColumnas(trx: Trx, empresaId: string, hasta: string): Promise<BalanceOchoColumnas> {
  const ejercicio = await ejercicioDe(trx, empresaId, hasta);
  const { rows } = await sql<{ codigo: string; nombre: string; clasificacion: string; debitos: string; creditos: string }>`
    SELECT c.codigo, c.nombre, c.clasificacion,
           sum(l.debe)::text AS debitos, sum(l.haber)::text AS creditos
    FROM asiento_lineas l
    JOIN asientos a ON a.id = l.asiento_id
    JOIN plan_cuentas c ON c.id = l.cuenta_id
    LEFT JOIN asientos o ON o.id = a.reversa_de
    WHERE l.empresa_id = ${empresaId}::uuid
      AND a.ejercicio_id = ${ejercicio.id}::uuid
      AND a.fecha <= ${hasta}::date
      AND ${sinCierre}
    GROUP BY c.codigo, c.nombre, c.clasificacion
    ORDER BY c.codigo`.execute(trx);

  const cero = (): Record<Columnas, bigint> => ({
    debitos: 0n, creditos: 0n, saldoDeudor: 0n, saldoAcreedor: 0n, activo: 0n, pasivo: 0n, perdida: 0n, ganancia: 0n,
  });
  const texto = (o: Record<Columnas, bigint>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deCentavos(v)])) as Record<Columnas, string>;

  const sumas = cero();
  const filas: FilaBalance[] = [];
  const cuentasDeOrden: BalanceOchoColumnas['cuentasDeOrden'] = [];
  for (const r of rows) {
    const debitos = aCentavos(r.debitos);
    const creditos = aCentavos(r.creditos);
    const saldoDeudor = maxCentavos(debitos - creditos, 0n);
    const saldoAcreedor = maxCentavos(creditos - debitos, 0n);
    if (r.clasificacion === 'ORDEN') {
      cuentasDeOrden.push({ codigo: r.codigo, nombre: r.nombre, saldoDeudor: deCentavos(saldoDeudor), saldoAcreedor: deCentavos(saldoAcreedor) });
      continue;
    }
    const resultado = CUENTAS_DE_RESULTADO.has(r.clasificacion);
    const valores: Record<Columnas, bigint> = {
      debitos,
      creditos,
      saldoDeudor,
      saldoAcreedor,
      activo: resultado ? 0n : saldoDeudor,
      pasivo: resultado ? 0n : saldoAcreedor,
      perdida: resultado ? saldoDeudor : 0n,
      ganancia: resultado ? saldoAcreedor : 0n,
    };
    for (const k of Object.keys(sumas) as Columnas[]) sumas[k] += valores[k];
    filas.push({ codigo: r.codigo, nombre: r.nombre, clasificacion: r.clasificacion, ...texto(valores) });
  }

  const resultado = sumas.ganancia - sumas.perdida;
  const totales = { ...sumas };
  // La utilidad se suma al lado menor para cuadrar: en resultados va a "pérdida"
  // y en inventario a "pasivo" (patrimonio); la pérdida, al revés.
  if (resultado >= 0n) {
    totales.perdida += resultado;
    totales.pasivo += resultado;
  } else {
    totales.ganancia += -resultado;
    totales.activo += -resultado;
  }
  const cuadrado =
    sumas.debitos === sumas.creditos &&
    sumas.saldoDeudor === sumas.saldoAcreedor &&
    totales.activo === totales.pasivo &&
    totales.perdida === totales.ganancia;

  return {
    ejercicio: ejercicio.anio,
    desde: ejercicio.fecha_inicio,
    hasta,
    filas,
    sumas: texto(sumas),
    resultadoEjercicio: deCentavos(resultado),
    totales: texto(totales),
    cuentasDeOrden,
    cuadrado,
  };
}

export interface MovimientoMayor {
  fecha: string;
  numero: number;
  cuenta: string;
  glosa: string;
  debe: string;
  haber: string;
  saldo: string;
  tercero: string | null;
}

/**
 * Libro mayor de una cuenta dentro de un ejercicio: saldo inicial (desde el
 * inicio del ejercicio, incluida la apertura, hasta el día anterior a "desde"),
 * movimientos del rango y saldo acumulado según la naturaleza de la cuenta.
 * Para una cuenta de agrupación se suman todas sus subcuentas.
 */
export async function libroMayor(trx: Trx, empresaId: string, codigoCuenta: string, desde: string, hasta: string) {
  if (desde > hasta) throw new ErrorNegocio('RANGO_INVALIDO', 'La fecha inicial es posterior a la final.', 422);
  const ejercicio = await ejercicioDe(trx, empresaId, desde);
  if (hasta > ejercicio.fecha_termino) {
    throw new ErrorNegocio('RANGO_INVALIDO', `El libro mayor se consulta dentro de un ejercicio (hasta el ${ejercicio.fecha_termino}).`, 422);
  }
  const cuenta = await trx
    .selectFrom('plan_cuentas')
    .select(['id', 'codigo', 'nombre', 'naturaleza', 'imputable'])
    .where('empresa_id', '=', empresaId)
    .where('codigo', '=', codigoCuenta)
    .executeTakeFirst();
  if (!cuenta) throw noEncontrado('La cuenta');
  const signo = cuenta.naturaleza === 'DEUDORA' ? 1n : -1n;

  // La cuenta y todas sus subcuentas (para una imputable, solo ella).
  const cuentas = sql`
    WITH RECURSIVE arbol(id) AS (
      SELECT ${cuenta.id}::uuid
      UNION
      SELECT h.id FROM plan_cuentas h JOIN arbol a ON h.padre_id = a.id
    )
    SELECT id FROM arbol`;

  const { rows: previo } = await sql<{ debe: string | null; haber: string | null }>`
    SELECT sum(l.debe)::text AS debe, sum(l.haber)::text AS haber
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    LEFT JOIN asientos o ON o.id = a.reversa_de
    WHERE l.empresa_id = ${empresaId}::uuid AND l.cuenta_id IN (${cuentas})
      AND a.ejercicio_id = ${ejercicio.id}::uuid AND a.fecha < ${desde}::date AND ${sinCierre}`.execute(trx);
  const saldoInicial = signo * (aCentavos(previo[0]?.debe ?? '0') - aCentavos(previo[0]?.haber ?? '0'));

  const { rows } = await sql<{ fecha: string; numero: number; cuenta: string; glosa: string; debe: string; haber: string; tercero: string | null }>`
    SELECT a.fecha::text AS fecha, a.numero, c.codigo AS cuenta, coalesce(l.glosa, a.glosa) AS glosa,
           l.debe::text AS debe, l.haber::text AS haber, t.rut AS tercero
    FROM asiento_lineas l
    JOIN asientos a ON a.id = l.asiento_id
    JOIN plan_cuentas c ON c.id = l.cuenta_id
    LEFT JOIN terceros t ON t.id = l.tercero_id
    LEFT JOIN asientos o ON o.id = a.reversa_de
    WHERE l.empresa_id = ${empresaId}::uuid AND l.cuenta_id IN (${cuentas})
      AND a.ejercicio_id = ${ejercicio.id}::uuid
      AND a.fecha BETWEEN ${desde}::date AND ${hasta}::date AND ${sinCierre}
    ORDER BY a.fecha, a.numero, l.linea`.execute(trx);

  let saldo = saldoInicial;
  let totalDebe = 0n;
  let totalHaber = 0n;
  const movimientos: MovimientoMayor[] = rows.map((r) => {
    const debe = aCentavos(r.debe);
    const haber = aCentavos(r.haber);
    totalDebe += debe;
    totalHaber += haber;
    saldo += signo * (debe - haber);
    return { ...r, saldo: deCentavos(saldo) };
  });

  return {
    cuenta: { codigo: cuenta.codigo, nombre: cuenta.nombre, naturaleza: cuenta.naturaleza, imputable: cuenta.imputable },
    ejercicio: ejercicio.anio,
    desde,
    hasta,
    saldoInicial: deCentavos(saldoInicial),
    movimientos,
    totalDebe: deCentavos(totalDebe),
    totalHaber: deCentavos(totalHaber),
    saldoFinal: deCentavos(saldo),
  };
}
