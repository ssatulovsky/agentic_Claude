import { ErrorNegocio } from '../errores.js';
import { detectarSeparador, normalizarTexto, separarFilas } from '../tributario/rcvCsv.js';
import { normalizarRut, rutEsValido } from '../utilidades/rut.js';
import { ErrorXls, leerXls, type Celda } from '../utilidades/xls.js';

/**
 * Lector de cartolas bancarias. Reconoce:
 *  - La cartola de Scotiabank Empresas en Excel (.xls): cabecera con número de cuenta,
 *    período, saldo anterior, totales y saldo actual; luego Fecha, Descripción, Número
 *    de documento, Cargo, Abono y Saldo diario.
 *  - La misma tabla en CSV o en otra planilla con esas columnas (formato genérico).
 * Nunca supone un dato: si la cartola no informa su saldo o no se entiende una fila,
 * se rechaza indicando la fila.
 */

export interface MovimientoLeido {
  fecha: string;
  descripcion: string;
  numero_documento: string | null;
  /** Abono positivo, cargo negativo (pesos enteros). */
  monto: number;
  saldo: number | null;
  rut_contraparte: string | null;
}

export interface CartolaLeida {
  formato: 'SCOTIABANK_XLS' | 'TABLA_GENERICA';
  cabecera: {
    numero_cuenta: string | null;
    moneda: string | null;
    numero_estado: number | null;
    desde: string;
    hasta: string;
    saldo_anterior: number;
    total_abonos: number;
    total_cargos: number;
    saldo_final: number;
  };
  movimientos: MovimientoLeido[];
}

const ETIQUETAS: Record<string, keyof Cabecera> = {
  'numero cuenta': 'numero_cuenta',
  'numero de cuenta': 'numero_cuenta',
  moneda: 'moneda',
  'estado de cuenta': 'numero_estado',
  'fecha desde': 'desde',
  'fecha hasta': 'hasta',
  'saldo anterior': 'saldo_anterior',
  'saldo inicial': 'saldo_anterior',
  'depositos abonos': 'total_abonos',
  'total abonos': 'total_abonos',
  'cargos giros': 'total_cargos',
  'total cargos': 'total_cargos',
  'saldo actual': 'saldo_final',
  'saldo final': 'saldo_final',
};
type Cabecera = {
  numero_cuenta: Celda;
  moneda: Celda;
  numero_estado: Celda;
  desde: Celda;
  hasta: Celda;
  saldo_anterior: Celda;
  total_abonos: Celda;
  total_cargos: Celda;
  saldo_final: Celda;
};

const corto = (v: unknown) => {
  const t = String(v ?? '');
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

function texto(c: Celda | undefined): string {
  return c === null || c === undefined ? '' : String(c).trim();
}

/** Monto en pesos enteros: número de la planilla o texto como "1.300.000", "-50.000" o "$ 81.000". */
function leerMonto(c: Celda | undefined): number | null {
  if (c === null || c === undefined || c === '') return 0;
  if (typeof c === 'number') return Number.isInteger(c) && Math.abs(c) <= 999_999_999_999_999 ? c : null;
  if (typeof c === 'boolean') return null;
  let v = c.replace(/[\s$]/gu, '');
  if (v === '' || v === '-') return 0;
  if (/^-?\d{1,3}(\.\d{3})+$/u.test(v)) v = v.replace(/\./gu, '');
  if (!/^-?\d{1,15}$/u.test(v)) return null;
  return Number(v);
}

function leerFecha(c: Celda | undefined): string | null {
  const v = texto(c);
  let r = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/u.exec(v);
  let a: number;
  let m: number;
  let d: number;
  if (r) {
    d = Number(r[1]);
    m = Number(r[2]);
    a = Number(r[3]);
  } else {
    r = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(v);
    if (!r) return null;
    a = Number(r[1]);
    m = Number(r[2]);
    d = Number(r[3]);
  }
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** RUT de la contraparte en descripciones como "TEF 76431675-4 NOMBRE". */
export function rutEnDescripcion(descripcion: string): string | null {
  for (const m of descripcion.matchAll(/(?<![\d.])(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK])(?![\dkK])/gu)) {
    const rut = normalizarRut(m[1]!);
    if (rutEsValido(rut)) return rut;
  }
  return null;
}

function filasDe(contenido: Buffer): { filas: Celda[][]; xls: boolean } {
  const esXls = contenido.length >= 8 && contenido.readUInt32BE(0) === 0xd0cf11e0;
  if (esXls) {
    try {
      return { filas: leerXls(contenido), xls: true };
    } catch (e) {
      throw new ErrorNegocio('CARTOLA_FORMATO', e instanceof ErrorXls ? `No se pudo leer la planilla: ${e.message}.` : 'No se pudo leer la planilla.', 422);
    }
  }
  const t = contenido.toString('utf8').replace(/^﻿/u, '');
  if (t.includes('\u0000')) throw new ErrorNegocio('CARTOLA_FORMATO', 'El archivo no es una planilla .xls ni un CSV.', 422);
  const primera = t.split(/\r?\n/u).find((l) => l.trim() !== '') ?? '';
  if (primera === '') throw new ErrorNegocio('CARTOLA_FORMATO', 'El archivo está vacío.', 422);
  // Una cabecera "clave;valor" tiene un solo separador: se busca el separador en todo el texto.
  const separador = detectarSeparador(t.slice(0, 5000));
  return { filas: separarFilas(t, separador), xls: false };
}

export function leerCartola(contenido: Buffer): CartolaLeida {
  const { filas, xls } = filasDe(contenido);

  // Cabecera (pares etiqueta/valor) hasta la fila de títulos de la tabla.
  const cab: Partial<Cabecera> = {};
  let titulos = -1;
  // La tabla empieza dentro de las primeras filas (cabecera corta).
  for (let i = 0; i < Math.min(filas.length, 60); i++) {
    const celdas = filas[i]!.map((c) => normalizarTexto(texto(c)));
    if (celdas.includes('fecha') && celdas.includes('descripcion') && celdas.some((c) => c.startsWith('cargo')) && celdas.some((c) => c.startsWith('abono'))) {
      titulos = i;
      break;
    }
    const etiqueta = ETIQUETAS[celdas[0] ?? ''];
    if (etiqueta) cab[etiqueta] = filas[i]![1] ?? null;
  }
  if (titulos < 0) {
    throw new ErrorNegocio('CARTOLA_FORMATO', 'No se encontró la tabla de movimientos (columnas Fecha, Descripción, Cargo y Abono).', 422);
  }
  const t = filas[titulos]!.map((c) => normalizarTexto(texto(c)));
  const col = (...nombres: string[]) => t.findIndex((c) => nombres.includes(c));
  const iFecha = col('fecha');
  const iDesc = col('descripcion');
  const iDoc = col('numero documento', 'n documento', 'documento', 'nro documento');
  const iCargo = col('cargo', 'cargos');
  const iAbono = col('abono', 'abonos');
  const iSaldo = col('saldo diario', 'saldo');

  const errores: string[] = [];
  const movimientos: MovimientoLeido[] = [];
  for (let i = titulos + 1; i < filas.length && errores.length < 20; i++) {
    const f = filas[i]!;
    if (f.every((c) => texto(c) === '')) continue;
    const n = xls ? i + 1 : i + 1;
    const fecha = leerFecha(f[iFecha]);
    if (!fecha) {
      errores.push(`Fila ${n}: fecha inválida ("${corto(f[iFecha])}")`);
      continue;
    }
    const descripcion = texto(f[iDesc]);
    if (descripcion === '') {
      errores.push(`Fila ${n}: sin descripción`);
      continue;
    }
    const cargo = leerMonto(f[iCargo]);
    const abono = leerMonto(f[iAbono]);
    const saldo = iSaldo >= 0 && texto(f[iSaldo]) !== '' ? leerMonto(f[iSaldo]) : null;
    if (cargo === null || abono === null || (iSaldo >= 0 && texto(f[iSaldo]) !== '' && saldo === null)) {
      errores.push(`Fila ${n}: monto inválido`);
      continue;
    }
    if (abono < 0) {
      errores.push(`Fila ${n}: abono negativo; las reversas de abonos van como cargo`);
      continue;
    }
    if ((cargo !== 0) === (abono !== 0)) {
      errores.push(`Fila ${n}: debe tener un cargo o un abono (y no ambos)`);
      continue;
    }
    const doc = iDoc >= 0 ? texto(f[iDoc]) : '';
    movimientos.push({
      fecha,
      descripcion,
      numero_documento: doc === '' || doc === '0' ? null : doc,
      monto: abono !== 0 ? Math.abs(abono) : -Math.abs(cargo),
      saldo,
      rut_contraparte: rutEnDescripcion(descripcion),
    });
  }
  if (errores.length > 0) {
    throw new ErrorNegocio('CARTOLA_DATOS', `La cartola tiene errores; no se importó nada. ${errores[0]}`, 422, { errores });
  }

  const numeroCampo = (k: keyof Cabecera) => {
    if (cab[k] === undefined || texto(cab[k]) === '') return null;
    const m = leerMonto(cab[k]);
    if (m === null) throw new ErrorNegocio('CARTOLA_FORMATO', `Valor inválido en la cabecera (${k}): "${corto(cab[k])}".`, 422);
    return m;
  };
  const abonos = movimientos.filter((m) => m.monto > 0).reduce((s, m) => s + m.monto, 0);
  const cargos = movimientos.filter((m) => m.monto < 0).reduce((s, m) => s - m.monto, 0);

  // Sin saldo final informado ni saldo diario en cada línea, nada permitiría verificar
  // que la cartola esté completa.
  if (numeroCampo('saldo_final') === null && movimientos.some((m) => m.saldo === null)) {
    throw new ErrorNegocio('CARTOLA_FORMATO', 'La cartola debe informar el saldo final o el saldo diario de cada movimiento.', 422);
  }
  let saldoAnterior = numeroCampo('saldo_anterior');
  if (saldoAnterior === null) {
    // Sin cabecera: el saldo anterior se deduce del saldo diario de la primera línea.
    const primero = movimientos[0];
    if (!primero || primero.saldo === null) {
      throw new ErrorNegocio('CARTOLA_FORMATO', 'La cartola no informa el saldo anterior ni el saldo diario.', 422);
    }
    saldoAnterior = primero.saldo - primero.monto;
  }
  const fechas = movimientos.map((m) => m.fecha).sort();
  const desde = cab.desde !== undefined ? leerFecha(cab.desde) : (fechas[0] ?? null);
  const hasta = cab.hasta !== undefined ? leerFecha(cab.hasta) : (fechas[fechas.length - 1] ?? null);
  if (!desde || !hasta) throw new ErrorNegocio('CARTOLA_FORMATO', 'La cartola no informa su período.', 422);
  const moneda = cab.moneda !== undefined ? texto(cab.moneda).toUpperCase() : null;
  if (moneda !== null && moneda !== 'CLP' && moneda !== '$') {
    throw new ErrorNegocio('CARTOLA_FORMATO', `Solo se aceptan cartolas en pesos chilenos (la cartola está en ${corto(moneda)}).`, 422);
  }
  const numeroEstado = numeroCampo('numero_estado');
  const numeroCuenta = cab.numero_cuenta !== undefined ? texto(cab.numero_cuenta).replace(/\D/gu, '') || null : null;

  return {
    formato: xls && cab.saldo_anterior !== undefined ? 'SCOTIABANK_XLS' : 'TABLA_GENERICA',
    cabecera: {
      numero_cuenta: numeroCuenta,
      moneda,
      numero_estado: numeroEstado,
      desde,
      hasta,
      saldo_anterior: saldoAnterior,
      total_abonos: numeroCampo('total_abonos') ?? abonos,
      total_cargos: Math.abs(numeroCampo('total_cargos') ?? cargos),
      saldo_final: numeroCampo('saldo_final') ?? saldoAnterior + abonos - cargos,
    },
    movimientos,
  };
}
