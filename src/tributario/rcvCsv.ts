import { ErrorNegocio } from '../errores.js';
import { normalizarRut, rutEsValido } from '../utilidades/rut.js';

/**
 * Lector del detalle del Registro de Compras y Ventas descargado del SII
 * ("Descargar detalles", archivo CSV).
 *
 * El SII no publica un formato formal de este archivo, así que el lector es
 * tolerante: reconoce el separador (punto y coma, coma o tabulador), ignora
 * mayúsculas, tildes y puntuación en los encabezados, y acepta los nombres de
 * columna conocidos. Las columnas que no reconoce se informan (no se descartan
 * en silencio) para revisar el formato con un archivo real.
 *
 * Nunca supone un dato: si falta una columna obligatoria o un valor no se
 * entiende, rechaza el archivo indicando la fila.
 */

export type Libro = 'COMPRA' | 'VENTA';

export type TipoOperacion =
  | 'DEL_GIRO'
  | 'SUPERMERCADOS'
  | 'BIENES_RAICES'
  | 'ACTIVO_FIJO'
  | 'IVA_USO_COMUN'
  | 'IVA_NO_RECUPERABLE'
  | 'NO_CORRESPONDE_INCLUIR';

export interface DocumentoRcv {
  tipo_documento: number;
  tipo_operacion: TipoOperacion;
  rut_contraparte: string;
  razon_social: string | null;
  folio: number;
  fecha_documento: string;
  fecha_recepcion: string | null;
  cantidad: number;
  monto_exento: number;
  monto_neto: number;
  monto_iva: number;
  iva_no_recuperable: number;
  codigo_iva_no_recuperable: number | null;
  iva_uso_comun: number;
  neto_activo_fijo: number;
  iva_activo_fijo: number;
  otros_impuestos: number;
  monto_total: number;
}

export interface LecturaRcv {
  documentos: DocumentoRcv[];
  separador: string;
  /** Encabezados que no se usaron (se informan para validar el formato). */
  columnasNoReconocidas: string[];
}

type Campo =
  | 'tipo_documento'
  | 'tipo_operacion'
  | 'rut_contraparte'
  | 'razon_social'
  | 'folio'
  | 'fecha_documento'
  | 'fecha_recepcion'
  | 'cantidad'
  | 'monto_exento'
  | 'monto_neto'
  | 'monto_iva'
  | 'iva_no_recuperable'
  | 'codigo_iva_no_recuperable'
  | 'iva_uso_comun'
  | 'neto_activo_fijo'
  | 'iva_activo_fijo'
  | 'otros_impuestos'
  | 'monto_total'
  | 'ignorar';

/** Encabezados conocidos, ya normalizados (minúsculas, sin tildes ni puntuación). */
const ALIAS: Record<string, Campo> = {
  'tipo doc': 'tipo_documento',
  'tipo docto': 'tipo_documento',
  'tipo documento': 'tipo_documento',
  'tipo dte': 'tipo_documento',
  'tipo compra': 'tipo_operacion',
  'tipo venta': 'tipo_operacion',
  'rut proveedor': 'rut_contraparte',
  'rut cliente': 'rut_contraparte',
  'rut receptor': 'rut_contraparte',
  'rut contraparte': 'rut_contraparte',
  'razon social': 'razon_social',
  folio: 'folio',
  'fecha docto': 'fecha_documento',
  'fecha documento': 'fecha_documento',
  'fecha emision': 'fecha_documento',
  'fecha recepcion': 'fecha_recepcion',
  'total documentos': 'cantidad',
  'monto exento': 'monto_exento',
  'monto neto': 'monto_neto',
  'monto iva': 'monto_iva',
  'monto iva recuperable': 'monto_iva',
  'monto iva no recuperable': 'iva_no_recuperable',
  'codigo iva no rec': 'codigo_iva_no_recuperable',
  'codigo iva no recuperable': 'codigo_iva_no_recuperable',
  'iva uso comun': 'iva_uso_comun',
  'monto neto activo fijo': 'neto_activo_fijo',
  'iva activo fijo': 'iva_activo_fijo',
  'valor otro impuesto': 'otros_impuestos',
  'valor otro imp': 'otros_impuestos',
  'impto sin derecho a credito': 'otros_impuestos',
  'monto total': 'monto_total',
  nro: 'ignorar',
};

const OPERACIONES: Record<string, TipoOperacion> = {
  'del giro': 'DEL_GIRO',
  giro: 'DEL_GIRO',
  supermercados: 'SUPERMERCADOS',
  'bienes raices': 'BIENES_RAICES',
  'activo fijo': 'ACTIVO_FIJO',
  'iva uso comun': 'IVA_USO_COMUN',
  'iva no recuperable': 'IVA_NO_RECUPERABLE',
  'no corresp incluir': 'NO_CORRESPONDE_INCLUIR',
  'no corresponde incluir': 'NO_CORRESPONDE_INCLUIR',
};

const OBLIGATORIOS: Campo[] = ['tipo_documento', 'tipo_operacion', 'rut_contraparte', 'folio', 'fecha_documento', 'monto_total'];
const TIPOS_NOTA_CREDITO = new Set([60, 61, 112]);
const MAX_ERRORES = 20;

export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function detectarSeparador(linea: string): string {
  const conteo = (c: string) => linea.split(c).length - 1;
  const candidatos = [';', ',', '\t'].map((c) => [c, conteo(c)] as const).sort((a, b) => b[1] - a[1]);
  const mejor = candidatos[0]!;
  if (mejor[1] === 0) throw new ErrorNegocio('RCV_FORMATO', 'El archivo no parece un CSV del RCV: no se reconoce el separador.', 422);
  return mejor[0];
}

/** CSV con comillas dobles (RFC 4180). */
function separarFilas(texto: string, separador: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else entreComillas = false;
      } else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === separador) {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (entreComillas) throw new ErrorNegocio('RCV_FORMATO', 'El archivo tiene comillas sin cerrar.', 422);
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas.filter((f) => f.some((v) => v.trim() !== ''));
}

function leerFecha(valor: string): string | null {
  const v = valor.trim();
  let a: number;
  let m: number;
  let d: number;
  let r = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/u.exec(v);
  if (r) {
    d = Number(r[1]);
    m = Number(r[2]);
    a = Number(r[3]);
  } else {
    r = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?$/u.exec(v);
    if (!r) return null;
    a = Number(r[1]);
    m = Number(r[2]);
    d = Number(r[3]);
  }
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Monto en pesos enteros. Acepta separador de miles con punto ("1.234.567"). */
function leerMonto(valor: string): number | null {
  let v = valor.trim().replace(/\s/gu, '');
  if (v === '') return 0;
  if (/^-?\d{1,3}(\.\d{3})+$/u.test(v)) v = v.replace(/\./gu, '');
  if (!/^-?\d{1,15}$/u.test(v)) return null;
  return Number(v);
}

export function leerRcvCsv(contenido: string, libro: Libro): LecturaRcv {
  const texto = contenido.replace(/^﻿/u, '');
  const primeraLinea = texto.split(/\r?\n/u, 1)[0] ?? '';
  if (primeraLinea.trim() === '') throw new ErrorNegocio('RCV_FORMATO', 'El archivo está vacío.', 422);
  const separador = detectarSeparador(primeraLinea);
  const [encabezado, ...filas] = separarFilas(texto, separador);
  if (!encabezado) throw new ErrorNegocio('RCV_FORMATO', 'El archivo está vacío.', 422);

  const columnas = new Map<Campo, number[]>();
  const columnasNoReconocidas: string[] = [];
  encabezado.forEach((nombre, i) => {
    const campo = ALIAS[normalizarTexto(nombre)];
    if (!campo) {
      if (nombre.trim() !== '') columnasNoReconocidas.push(nombre.trim());
      return;
    }
    if (campo === 'ignorar') return;
    columnas.set(campo, [...(columnas.get(campo) ?? []), i]);
  });
  const faltantes = OBLIGATORIOS.filter((c) => !columnas.has(c));
  if (faltantes.length > 0) {
    throw new ErrorNegocio('RCV_FORMATO', `Faltan columnas obligatorias en el archivo: ${faltantes.join(', ')}.`, 422, {
      faltantes,
      encabezado,
    });
  }
  for (const [campo, indices] of columnas) {
    if (indices.length > 1 && campo !== 'otros_impuestos') {
      throw new ErrorNegocio('RCV_FORMATO', `La columna ${campo} aparece más de una vez en el archivo.`, 422);
    }
  }

  const errores: string[] = [];
  const documentos: DocumentoRcv[] = [];
  const claves = new Set<string>();

  filas.forEach((fila, i) => {
    if (errores.length >= MAX_ERRORES) return;
    const nFila = i + 2;
    const valor = (campo: Campo) => {
      const idx = columnas.get(campo)?.[0];
      return idx === undefined ? '' : (fila[idx] ?? '').trim();
    };
    const error = (msg: string) => errores.push(`Fila ${nFila}: ${msg}`);

    const tipoTexto = valor('tipo_documento');
    const tipo = /^\d{1,4}$/u.test(tipoTexto) ? Number(tipoTexto) : NaN;
    if (!Number.isInteger(tipo) || tipo <= 0) return error(`tipo de documento inválido ("${tipoTexto}")`);

    const operacionTexto = normalizarTexto(valor('tipo_operacion'));
    const operacion = OPERACIONES[operacionTexto];
    if (!operacion) return error(`tipo de ${libro === 'COMPRA' ? 'compra' : 'venta'} no reconocido ("${valor('tipo_operacion')}")`);
    if (libro === 'VENTA' && !['DEL_GIRO', 'BIENES_RAICES', 'ACTIVO_FIJO'].includes(operacion)) {
      return error(`tipo de venta no válido ("${valor('tipo_operacion')}")`);
    }

    const rut = normalizarRut(valor('rut_contraparte'));
    if (!rutEsValido(rut)) return error(`RUT inválido ("${valor('rut_contraparte')}")`);

    const folioTexto = valor('folio');
    if (!/^\d{1,18}$/u.test(folioTexto) || Number(folioTexto) <= 0 || !Number.isSafeInteger(Number(folioTexto))) {
      return error(`folio inválido ("${folioTexto}")`);
    }
    const folio = Number(folioTexto);

    const fechaDocumento = leerFecha(valor('fecha_documento'));
    if (!fechaDocumento) return error(`fecha del documento inválida ("${valor('fecha_documento')}")`);
    const recepcionTexto = valor('fecha_recepcion');
    const fechaRecepcion = recepcionTexto === '' ? null : leerFecha(recepcionTexto);
    if (recepcionTexto !== '' && !fechaRecepcion) return error(`fecha de recepción inválida ("${recepcionTexto}")`);

    const cantidadTexto = valor('cantidad');
    const cantidad = cantidadTexto === '' ? 1 : /^\d{1,9}$/u.test(cantidadTexto) ? Number(cantidadTexto) : NaN;
    if (!Number.isInteger(cantidad) || cantidad <= 0) return error(`cantidad de documentos inválida ("${cantidadTexto}")`);

    const montos: Partial<Record<Campo, number>> = {};
    const camposMonto: Campo[] = [
      'monto_exento',
      'monto_neto',
      'monto_iva',
      'iva_no_recuperable',
      'iva_uso_comun',
      'neto_activo_fijo',
      'iva_activo_fijo',
      'monto_total',
    ];
    for (const campo of camposMonto) {
      const m = leerMonto(valor(campo));
      if (m === null) return error(`monto inválido en ${campo} ("${valor(campo)}")`);
      if (m < 0 && !TIPOS_NOTA_CREDITO.has(tipo)) return error(`monto negativo en ${campo} en un documento que no es nota de crédito`);
      montos[campo] = Math.abs(m);
    }
    let otros = 0;
    for (const idx of columnas.get('otros_impuestos') ?? []) {
      const m = leerMonto(fila[idx] ?? '');
      if (m === null) return error(`monto inválido en otros impuestos ("${fila[idx] ?? ''}")`);
      otros += Math.abs(m);
    }

    const codigoTexto = valor('codigo_iva_no_recuperable');
    const codigoNoRec = codigoTexto === '' ? null : /^\d{1,3}$/u.test(codigoTexto) ? Number(codigoTexto) : NaN;
    if (Number.isNaN(codigoNoRec)) return error(`código de IVA no recuperable inválido ("${codigoTexto}")`);

    const clave = `${tipo}|${rut}|${folio}`;
    if (claves.has(clave)) return error(`documento repetido (tipo ${tipo}, RUT ${rut}, folio ${folio})`);
    claves.add(clave);

    documentos.push({
      tipo_documento: tipo,
      tipo_operacion: operacion,
      rut_contraparte: rut,
      razon_social: valor('razon_social') || null,
      folio,
      fecha_documento: fechaDocumento,
      fecha_recepcion: fechaRecepcion,
      cantidad,
      monto_exento: montos.monto_exento ?? 0,
      monto_neto: montos.monto_neto ?? 0,
      monto_iva: montos.monto_iva ?? 0,
      iva_no_recuperable: montos.iva_no_recuperable ?? 0,
      codigo_iva_no_recuperable: codigoNoRec,
      iva_uso_comun: montos.iva_uso_comun ?? 0,
      neto_activo_fijo: montos.neto_activo_fijo ?? 0,
      iva_activo_fijo: montos.iva_activo_fijo ?? 0,
      otros_impuestos: otros,
      monto_total: montos.monto_total ?? 0,
    });
  });

  if (errores.length > 0) {
    throw new ErrorNegocio('RCV_DATOS', `El archivo tiene errores; no se importó nada. ${errores[0]}`, 422, { errores });
  }
  return { documentos, separador, columnasNoReconocidas };
}
