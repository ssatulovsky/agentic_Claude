import CFB from 'cfb';

/**
 * Lector mínimo de planillas Excel 97-2003 (.xls, formato BIFF8), como las cartolas
 * que descargan los bancos chilenos. Lee solo la primera hoja y solo los valores de
 * las celdas (texto y números); ignora formatos, fórmulas sin resultado y gráficos.
 *
 * Se escribió en vez de usar una biblioteca general porque las versiones publicadas
 * en npm de la más usada tienen vulnerabilidades conocidas al leer archivos subidos
 * por usuarios. El contenedor (Compound File) se lee con `cfb`.
 */

export type Celda = string | number | boolean | null;

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILAS = 100_000;
const MAX_COLUMNAS = 256;

export class ErrorXls extends Error {}

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
} as const;

interface Registro {
  tipo: number;
  datos: Buffer;
  posicion: number;
}

function* registros(flujo: Buffer, desde = 0): Generator<Registro> {
  let p = desde;
  while (p + 4 <= flujo.length) {
    const tipo = flujo.readUInt16LE(p);
    const largo = flujo.readUInt16LE(p + 2);
    if (p + 4 + largo > flujo.length) throw new ErrorXls('Registro truncado');
    yield { tipo, datos: flujo.subarray(p + 4, p + 4 + largo), posicion: p };
    p += 4 + largo;
  }
}

function decodificarRk(rk: number): number {
  let valor: number;
  if (rk & 0x02) {
    valor = rk >> 2; // entero de 30 bits con signo
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    valor = b.readDoubleLE(0);
  }
  return rk & 0x01 ? valor / 100 : valor;
}

/** Texto XLUnicodeString con largo de 16 bits (registros LABEL y STRING). */
function leerTexto16(d: Buffer, p: number): string {
  if (p + 3 > d.length) throw new ErrorXls('Texto truncado');
  const cch = d.readUInt16LE(p);
  const alto = d.readUInt8(p + 2) & 0x01;
  const inicio = p + 3;
  const fin = inicio + cch * (alto ? 2 : 1);
  if (fin > d.length) throw new ErrorXls('Texto truncado');
  return alto ? d.toString('utf16le', inicio, fin) : d.toString('latin1', inicio, fin);
}

/**
 * Tabla de textos compartidos (SST). Los textos pueden continuar en registros CONTINUE;
 * al cruzar un límite, los caracteres siguientes traen un nuevo byte de opciones.
 */
function leerSst(segmentos: Buffer[]): string[] {
  let seg = 0;
  let p = 0;
  const disponible = () => segmentos[seg]!.length - p;
  const avanzarSiFin = () => {
    while (seg < segmentos.length && p >= segmentos[seg]!.length) {
      seg++;
      p = 0;
    }
    if (seg >= segmentos.length) throw new ErrorXls('Tabla de textos truncada');
  };
  const u8 = () => {
    avanzarSiFin();
    return segmentos[seg]!.readUInt8(p++);
  };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const saltar = (n: number) => {
    let resto = n;
    while (resto > 0) {
      avanzarSiFin();
      const k = Math.min(resto, disponible());
      p += k;
      resto -= k;
    }
  };

  u32(); // total de referencias
  const unicos = u32();
  if (unicos > 1_000_000) throw new ErrorXls('Tabla de textos demasiado grande');
  const textos: string[] = [];
  for (let i = 0; i < unicos; i++) {
    const cch = u16();
    const opciones = u8();
    let alto = opciones & 0x01;
    const corridas = opciones & 0x08 ? u16() : 0;
    const extendido = opciones & 0x04 ? u32() : 0;
    let texto = '';
    let restantes = cch;
    while (restantes > 0) {
      avanzarSiFin();
      if (disponible() === 0) continue;
      const ancho = alto ? 2 : 1;
      const k = Math.min(restantes, Math.floor(disponible() / ancho));
      if (k === 0) throw new ErrorXls('Texto partido de forma inválida');
      const d = segmentos[seg]!;
      texto += alto ? d.toString('utf16le', p, p + k * 2) : d.toString('latin1', p, p + k);
      p += k * ancho;
      restantes -= k;
      if (restantes > 0) {
        // Continúa en el siguiente registro CONTINUE, con un nuevo byte de opciones.
        seg++;
        p = 0;
        if (seg >= segmentos.length) throw new ErrorXls('Tabla de textos truncada');
        alto = segmentos[seg]!.readUInt8(p++) & 0x01;
      }
    }
    saltar(corridas * 4 + extendido);
    textos.push(texto);
  }
  return textos;
}

/** Lee la primera hoja de un archivo .xls como matriz de celdas. */
export function leerXls(contenido: Buffer): Celda[][] {
  if (contenido.length > MAX_BYTES) throw new ErrorXls('El archivo es demasiado grande');
  let contenedor: CFB.CFB$Container;
  try {
    contenedor = CFB.read(contenido, { type: 'buffer' });
  } catch {
    throw new ErrorXls('El archivo no es una planilla Excel 97-2003 (.xls)');
  }
  const entrada = CFB.find(contenedor, 'Workbook') ?? CFB.find(contenedor, 'Book');
  if (!entrada?.content) throw new ErrorXls('El archivo no contiene un libro de Excel');
  const flujo = Buffer.from(entrada.content as Uint8Array);

  // Globales: tabla de textos y posición de la primera hoja.
  let posicionHoja: number | null = null;
  const sst: Buffer[] = [];
  let enSst = false;
  for (const r of registros(flujo)) {
    if (r.tipo === R.SST) {
      sst.push(r.datos);
      enSst = true;
      continue;
    }
    if (r.tipo === R.CONTINUE && enSst) {
      sst.push(r.datos);
      continue;
    }
    enSst = false;
    if (r.tipo === R.BOUNDSHEET && posicionHoja === null) {
      const tipoHoja = r.datos.readUInt8(5);
      if (tipoHoja === 0) posicionHoja = r.datos.readUInt32LE(0);
    }
    if (r.tipo === R.EOF) break;
  }
  if (posicionHoja === null || posicionHoja >= flujo.length) throw new ErrorXls('El libro no tiene hojas de datos');
  const textos = sst.length > 0 ? leerSst(sst) : [];

  const filas: Celda[][] = [];
  const poner = (fila: number, col: number, valor: Celda) => {
    if (fila >= MAX_FILAS || col >= MAX_COLUMNAS) throw new ErrorXls('La hoja excede el tamaño permitido');
    while (filas.length <= fila) filas.push([]);
    const f = filas[fila]!;
    while (f.length <= col) f.push(null);
    f[col] = valor;
  };

  let formulaPendiente: { fila: number; col: number } | null = null;
  let primero = true;
  for (const r of registros(flujo, posicionHoja)) {
    if (primero) {
      if (r.tipo !== R.BOF) throw new ErrorXls('La hoja no comienza donde indica el libro');
      primero = false;
      continue;
    }
    const d = r.datos;
    const exigir = (n: number) => {
      if (d.length < n) throw new ErrorXls('Registro de celda truncado');
    };
    switch (r.tipo) {
      case R.EOF:
        return filas;
      case R.NUMBER:
        exigir(14);
        poner(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
        break;
      case R.RK:
        exigir(10);
        poner(d.readUInt16LE(0), d.readUInt16LE(2), decodificarRk(d.readUInt32LE(6)));
        break;
      case R.MULRK: {
        exigir(6);
        const fila = d.readUInt16LE(0);
        const primera = d.readUInt16LE(2);
        const ultima = d.readUInt16LE(d.length - 2);
        if (ultima < primera || 4 + (ultima - primera + 1) * 6 + 2 !== d.length) throw new ErrorXls('Registro MULRK inválido');
        for (let c = primera; c <= ultima; c++) {
          poner(fila, c, decodificarRk(d.readUInt32LE(4 + (c - primera) * 6 + 2)));
        }
        break;
      }
      case R.LABELSST: {
        exigir(10);
        const i = d.readUInt32LE(6);
        if (i >= textos.length) throw new ErrorXls('Referencia a texto inexistente');
        poner(d.readUInt16LE(0), d.readUInt16LE(2), textos[i]!);
        break;
      }
      case R.LABEL:
        exigir(9);
        poner(d.readUInt16LE(0), d.readUInt16LE(2), leerTexto16(d, 6));
        break;
      case R.BOOLERR:
        exigir(8);
        poner(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt8(7) === 0 ? d.readUInt8(6) === 1 : null);
        break;
      case R.FORMULA: {
        exigir(20);
        const fila = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        if (d.readUInt16LE(12) === 0xffff) {
          const tipo = d.readUInt8(6);
          if (tipo === 0) formulaPendiente = { fila, col }; // el texto viene en un registro STRING
          else if (tipo === 1) poner(fila, col, d.readUInt8(8) === 1);
          else poner(fila, col, null);
        } else {
          poner(fila, col, d.readDoubleLE(6));
        }
        break;
      }
      case R.STRING:
        if (formulaPendiente) {
          poner(formulaPendiente.fila, formulaPendiente.col, leerTexto16(d, 0));
          formulaPendiente = null;
        }
        break;
      default:
        break;
    }
  }
  throw new ErrorXls('La hoja no termina correctamente');
}
