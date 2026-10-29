import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio, noEncontrado } from '../errores.js';
import { aCentavos, deCentavos, maxCentavos } from '../utilidades/montos.js';

/**
 * Reportes contables calculados desde los asientos (nunca desde saldos guardados).
 * Solo se ven las líneas que el usuario puede ver: la seguridad por fila aplica.
 */

const CUENTAS_DE_RESULTADO = new Set(['INGRESO', 'GASTO']);

export interface FilaBalance {
  codigo: string;
  nombre: string;
  clasificacion: string;
  debitos: string;
  creditos: string;
  saldoDeudor: string;
  saldoAcreedor: string;
  activo: string;
  pasivo: string;
  perdida: string;
  ganancia: string;
}

export interface BalanceOchoColumnas {
  desde: string;
  hasta: string;
  filas: FilaBalance[];
  sumas: Omit<FilaBalance, 'codigo' | 'nombre' | 'clasificacion'>;
  /** Positivo = utilidad; negativo = pérdida. */
  resultadoEjercicio: string;
  /** Totales luego de agregar el resultado en la columna que corresponde. */
  totales: Omit<FilaBalance, 'codigo' | 'nombre' | 'clasificacion'>;
  cuadrado: boolean;
}

/**
 * Balance de comprobación y saldos (8 columnas): débitos, créditos, saldos
 * deudor y acreedor, inventario (activo, pasivo) y resultados (pérdida, ganancia).
 */
export async function balanceOchoColumnas(trx: Trx, empresaId: string, desde: string, hasta: string): Promise<BalanceOchoColumnas> {
  if (desde > hasta) throw new ErrorNegocio('RANGO_INVALIDO', 'La fecha inicial es posterior a la final.', 422);
  const { rows } = await sql<{ codigo: string; nombre: string; clasificacion: string; debitos: string; creditos: string }>`
    SELECT c.codigo, c.nombre, c.clasificacion,
           sum(l.debe)::text AS debitos, sum(l.haber)::text AS creditos
    FROM asiento_lineas l
    JOIN asientos a ON a.id = l.asiento_id
    JOIN plan_cuentas c ON c.id = l.cuenta_id
    WHERE l.empresa_id = ${empresaId}::uuid AND a.fecha BETWEEN ${desde}::date AND ${hasta}::date
    GROUP BY c.codigo, c.nombre, c.clasificacion
    ORDER BY c.codigo`.execute(trx);

  const cero = { debitos: 0n, creditos: 0n, saldoDeudor: 0n, saldoAcreedor: 0n, activo: 0n, pasivo: 0n, perdida: 0n, ganancia: 0n };
  const sumas = { ...cero };
  const filas: FilaBalance[] = rows.map((r) => {
    const debitos = aCentavos(r.debitos);
    const creditos = aCentavos(r.creditos);
    const saldoDeudor = maxCentavos(debitos - creditos, 0n);
    const saldoAcreedor = maxCentavos(creditos - debitos, 0n);
    const resultado = CUENTAS_DE_RESULTADO.has(r.clasificacion);
    const valores = {
      debitos,
      creditos,
      saldoDeudor,
      saldoAcreedor,
      activo: resultado ? 0n : saldoDeudor,
      pasivo: resultado ? 0n : saldoAcreedor,
      perdida: resultado ? saldoDeudor : 0n,
      ganancia: resultado ? saldoAcreedor : 0n,
    };
    for (const k of Object.keys(sumas) as (keyof typeof sumas)[]) sumas[k] += valores[k];
    return {
      codigo: r.codigo,
      nombre: r.nombre,
      clasificacion: r.clasificacion,
      ...(Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, deCentavos(v)])) as Record<keyof typeof cero, string>),
    };
  });

  const resultado = sumas.ganancia - sumas.perdida;
  const totales = { ...sumas };
  // La utilidad se suma al lado menor para cuadrar: en resultados va a "pérdida"
  // (columna deudora) y en inventario a "pasivo" (patrimonio); la pérdida, al revés.
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

  const texto = (o: typeof cero) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deCentavos(v)])) as Record<keyof typeof cero, string>;
  return { desde, hasta, filas, sumas: texto(sumas), resultadoEjercicio: deCentavos(resultado), totales: texto(totales), cuadrado };
}

export interface MovimientoMayor {
  fecha: string;
  numero: number;
  glosa: string;
  debe: string;
  haber: string;
  saldo: string;
  tercero: string | null;
}

/**
 * Libro mayor de una cuenta: saldo inicial (movimientos del mismo ejercicio
 * anteriores a "desde"), movimientos del rango y saldo acumulado según la
 * naturaleza de la cuenta (deudora: debe − haber; acreedora: haber − debe).
 */
export async function libroMayor(trx: Trx, empresaId: string, codigoCuenta: string, desde: string, hasta: string) {
  if (desde > hasta) throw new ErrorNegocio('RANGO_INVALIDO', 'La fecha inicial es posterior a la final.', 422);
  const cuenta = await trx
    .selectFrom('plan_cuentas')
    .select(['id', 'codigo', 'nombre', 'naturaleza', 'imputable'])
    .where('empresa_id', '=', empresaId)
    .where('codigo', '=', codigoCuenta)
    .executeTakeFirst();
  if (!cuenta) throw noEncontrado('La cuenta');

  const ejercicio = await trx
    .selectFrom('ejercicios_contables')
    .select(['fecha_inicio'])
    .where('empresa_id', '=', empresaId)
    .where('fecha_inicio', '<=', desde)
    .where('fecha_termino', '>=', desde)
    .executeTakeFirst();
  const inicioEjercicio = ejercicio?.fecha_inicio ?? desde;
  const signo = cuenta.naturaleza === 'DEUDORA' ? 1n : -1n;

  const { rows: previo } = await sql<{ debe: string | null; haber: string | null }>`
    SELECT sum(l.debe)::text AS debe, sum(l.haber)::text AS haber
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    WHERE l.empresa_id = ${empresaId}::uuid AND l.cuenta_id = ${cuenta.id}::uuid
      AND a.fecha >= ${inicioEjercicio}::date AND a.fecha < ${desde}::date`.execute(trx);
  const saldoInicial = signo * (aCentavos(previo[0]?.debe ?? '0') - aCentavos(previo[0]?.haber ?? '0'));

  const { rows } = await sql<{ fecha: string; numero: number; glosa: string; debe: string; haber: string; tercero: string | null }>`
    SELECT a.fecha::text AS fecha, a.numero, coalesce(l.glosa, a.glosa) AS glosa,
           l.debe::text AS debe, l.haber::text AS haber, t.rut AS tercero
    FROM asiento_lineas l
    JOIN asientos a ON a.id = l.asiento_id
    LEFT JOIN terceros t ON t.id = l.tercero_id
    WHERE l.empresa_id = ${empresaId}::uuid AND l.cuenta_id = ${cuenta.id}::uuid
      AND a.fecha BETWEEN ${desde}::date AND ${hasta}::date
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
    return { fecha: r.fecha, numero: r.numero, glosa: r.glosa, debe: r.debe, haber: r.haber, saldo: deCentavos(saldo), tercero: r.tercero };
  });

  return {
    cuenta: { codigo: cuenta.codigo, nombre: cuenta.nombre, naturaleza: cuenta.naturaleza },
    desde,
    hasta,
    saldoInicial: deCentavos(saldoInicial),
    movimientos,
    totalDebe: deCentavos(totalDebe),
    totalHaber: deCentavos(totalHaber),
    saldoFinal: deCentavos(saldo),
  };
}
