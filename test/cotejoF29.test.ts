import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { aprobarF29, configurarTasaPpm, obtenerF29, prepararF29 } from '../src/tributario/f29.js';
import { importarRcv } from '../src/tributario/rcv.js';
import { leerRcvCsv } from '../src/tributario/rcvCsv.js';
import { crearEscenario, type Escenario } from './escenario.js';

/*
 * Cotejo con los F29 declarados por la empresa piloto (julio, agosto y septiembre de 2026)
 * y con un archivo real del RCV descargado del SII (anonimizado: proveedor, RUT y folio
 * ficticios; encabezado, formato y montos tal como los entrega el SII).
 *
 * Los RCV de julio a septiembre se reconstruyen a partir de los totales declarados,
 * porque solo se contó con el resumen de compras de julio. Las cifras esperadas son las
 * de los formularios declarados, código por código.
 */

const ARCHIVO_SII = readFileSync(new URL('./datos/rcv_compra_detalle_sii.csv', import.meta.url), 'utf8');
const ENCABEZADO_COMPRAS = ARCHIVO_SII.split('\n')[0]!;
const ENCABEZADO_VENTAS =
  'Nro;Tipo Doc;Tipo Venta;Rut cliente;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse Recibo;Fecha Reclamo;Monto Exento;Monto Neto;Monto IVA;Monto total;IVA Retenido Total;IVA Retenido Parcial;IVA no retenido;IVA propio;IVA Terceros';

/** Códigos con valor distinto de cero en los F29 declarados. */
const DECLARADOS: Record<string, Record<string, number>> = {
  '2026-07': { '584': 1, '562': 30_000 },
  '2026-08': { '586': 2, '142': 7_500_000, '563': 7_500_000, '115': 0.2, '62': 15_000, '595': 15_000, '91': 15_000 },
  '2026-09': {},
};

let e: Escenario;
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);

const importar = (libro: 'COMPRA' | 'VENTA', mes: number, contenido: string) =>
  comoContador((trx) =>
    importarRcv(trx, { empresaId: e.empresaA1, libro, anio: 2026, mes, archivoNombre: `rcv-${libro}-2026-${mes}.csv`, contenido }),
  );

/** Códigos distintos de cero (la tasa de PPM solo cuenta si hubo base). */
function noCero(codigos: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(codigos)
      .map(([k, v]) => [k, Number(v)] as const)
      .filter(([k, v]) => v !== 0 && !(k === '115' && Number(codigos['563'] ?? 0) === 0)),
  );
}

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(
    `INSERT INTO suscripciones_modulo (empresa_id, modulo_codigo, pagador, vigente_desde) VALUES ($1, 'TRIBUTARIO', 'EMPRESA', '2026-01-01')`,
    [e.empresaA1],
  );
  await comoContador((trx) => configurarTasaPpm(trx, e.empresaA1, '2026-04-01', 0.2, 'Tasa del F29 declarado de agosto 2026 (código 115)'));
});
afterAll(async () => {
  await e.cerrar();
});

describe('Archivo real del RCV descargado del SII', () => {
  it('reconoce todas las columnas del detalle de compras y lee los montos tal como vienen', () => {
    const l = leerRcvCsv(ARCHIVO_SII, 'COMPRA');
    expect(l.columnasNoReconocidas).toEqual([]);
    expect(l.advertencias).toEqual([]);
    expect(l.documentos).toEqual([
      expect.objectContaining({
        tipo_documento: 33,
        tipo_operacion: 'DEL_GIRO',
        fecha_documento: '2026-04-27',
        fecha_recepcion: '2026-04-29',
        monto_neto: 3445,
        monto_iva: 655,
        monto_total: 4100,
      }),
    ]);
  });

  it('rechaza el archivo de resumen con una indicación de qué descargar', () => {
    const resumen =
      'Tipo Documento;Total Documentos;Monto Exento;Monto Neto;IVA Recuperable;IVA Uso Comun;IVA No Recuperable;Monto Total\n' +
      'Factura no Afecta o Exenta Electrónica(34);1;30000;0;0;0;0;30000\n';
    expect(() => leerRcvCsv(resumen, 'COMPRA')).toThrow(/Descargar Detalles/u);
  });

  it('el archivo real se importa y se traspasa al F29 (abril 2026)', async () => {
    await importar('COMPRA', 4, ARCHIVO_SII);
    await importar('VENTA', 4, ENCABEZADO_VENTAS);
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 4, remanenteAnterior: 0 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    expect(noCero(f.codigos)).toEqual({ '519': 1, '520': 655, '537': 655, '77': 655 });
  });
});

describe('Cotejo con los F29 declarados (julio a septiembre de 2026)', () => {
  it('julio: una compra exenta, sin ventas', async () => {
    await importar('COMPRA', 7, `${ENCABEZADO_COMPRAS}\n1;34;Del Giro;76111222-8;PROVEEDOR EXENTO SPA;55;10/07/2026;10/07/2026 10:00:00;;30000;0;0;;;30000;;;;;0;;;;0;;;;\n`);
    await importar('VENTA', 7, ENCABEZADO_VENTAS);
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 7, remanenteAnterior: 0 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    expect(noCero(f.codigos)).toEqual(DECLARADOS['2026-07']);
    await comoContador((trx) => aprobarF29(trx, id, true));
  });

  it('agosto: dos facturas exentas por $7.500.000, PPM al 0,2%', async () => {
    const ventas = [
      ENCABEZADO_VENTAS,
      '1;34;Del Giro;76543210-3;CLIENTE UNO SPA;10;05/08/2026;05/08/2026;;;5000000;0;0;5000000;0;0;0;0;0',
      '2;34;Del Giro;76111222-8;CLIENTE DOS SPA;11;20/08/2026;20/08/2026;;;2500000;0;0;2500000;0;0;0;0;0',
    ].join('\n');
    await importar('VENTA', 8, ventas);
    await importar('COMPRA', 8, ENCABEZADO_COMPRAS);
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 8 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    expect(noCero(f.codigos)).toEqual(DECLARADOS['2026-08']);
    // El remanente sale del F29 de julio registrado en el sistema, sin advertencias.
    expect(f.advertencias).toEqual([]);
    await comoContador((trx) => aprobarF29(trx, id, false));
  });

  it('septiembre: sin movimiento', async () => {
    await importar('VENTA', 9, ENCABEZADO_VENTAS);
    await importar('COMPRA', 9, ENCABEZADO_COMPRAS);
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 9 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    expect(noCero(f.codigos)).toEqual(DECLARADOS['2026-09']);
    expect(f.codigos['91']).toBe(0);
  });
});
