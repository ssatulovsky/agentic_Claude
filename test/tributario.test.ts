import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { ejecutarHerramienta, resolverPropuesta } from '../src/agentes/ejecutor.js';
import { sql } from 'kysely';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { ErrorNegocio } from '../src/errores.js';
import {
  anularF29,
  aprobarF29,
  configurarTasaPpm,
  listarF29,
  obtenerF29,
  prepararF29,
  registrarDeclaracionF29,
} from '../src/tributario/f29.js';
import { importarRcv, resumenRcv } from '../src/tributario/rcv.js';
import { leerRcvCsv } from '../src/tributario/rcvCsv.js';
import { crearEscenario, rutAleatorio, type Escenario } from './escenario.js';

// ---------------------------------------------------------------------------
// Archivos de prueba con el formato de "Descargar detalles" del RCV
// ---------------------------------------------------------------------------
const ENCABEZADO_COMPRAS =
  'Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse;Monto Exento;Monto Neto;Monto IVA Recuperable;Monto Iva No Recuperable;Codigo IVA No Rec.;Monto Total;Monto Neto Activo Fijo;IVA Activo Fijo;IVA uso Comun;Impto. Sin Derecho a Credito;IVA No Retenido;Codigo Otro Impuesto;Valor Otro Impuesto;Tasa Otro Impuesto';
const ENCABEZADO_VENTAS =
  'Nro;Tipo Doc;Tipo Venta;Rut cliente;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse Recibo;Fecha Reclamo;Monto Exento;Monto Neto;Monto IVA;Monto total;IVA Retenido Total;IVA Retenido Parcial;IVA no retenido;IVA propio;IVA Terceros';

interface Compra {
  tipo: number;
  op: string;
  folio: number;
  exento?: number;
  neto?: number;
  iva?: number;
  ivaNoRec?: number;
  netoAf?: number;
  ivaAf?: number;
  ivaUc?: number;
  total: number;
}
interface Venta {
  tipo: number;
  op: string;
  folio: number;
  exento?: number;
  neto?: number;
  iva?: number;
  total: number;
}

const PROVEEDOR = rutAleatorio();
const CLIENTE = rutAleatorio();

function csvCompras(filas: Compra[], mes = '06/2026'): string {
  const lineas = filas.map(
    (f, i) =>
      `${i + 1};${f.tipo};${f.op};${PROVEEDOR};"Proveedor; Ltda.";${f.folio};15/${mes};16/${mes} 10:20:00;;${f.exento ?? 0};${f.neto ?? 0};${f.iva ?? 0};${f.ivaNoRec ?? 0};${f.ivaNoRec ? 1 : ''};${f.total};${f.netoAf ?? 0};${f.ivaAf ?? 0};${f.ivaUc ?? 0};0;0;;;`,
  );
  return `﻿${[ENCABEZADO_COMPRAS, ...lineas].join('\r\n')}\r\n`;
}

function csvVentas(filas: Venta[], mes = '06/2026'): string {
  const lineas = filas.map(
    (f, i) =>
      `${i + 1};${f.tipo};${f.op};${CLIENTE};Cliente SpA;${f.folio};10/${mes};10/${mes};;;${f.exento ?? 0};${f.neto ?? 0};${f.iva ?? 0};${f.total};0;0;0;0;0`,
  );
  return [ENCABEZADO_VENTAS, ...lineas].join('\n');
}

const VENTAS_JUNIO: Venta[] = [
  { tipo: 33, op: 'Del Giro', folio: 101, neto: 1_000_000, iva: 190_000, total: 1_190_000 },
  { tipo: 33, op: 'Del Giro', folio: 102, exento: 100_000, neto: 500_000, iva: 95_000, total: 695_000 },
  { tipo: 34, op: 'Del Giro', folio: 7, exento: 200_000, total: 200_000 },
  { tipo: 61, op: 'Del Giro', folio: 9, neto: 100_000, iva: 19_000, total: 119_000 },
  { tipo: 33, op: 'Activo Fijo', folio: 103, neto: 300_000, iva: 57_000, total: 357_000 },
];

const COMPRAS_JUNIO: Compra[] = [
  { tipo: 33, op: 'Del Giro', folio: 501, neto: 400_000, iva: 76_000, total: 476_000 },
  { tipo: 33, op: 'Activo Fijo', folio: 502, netoAf: 1_000_000, ivaAf: 190_000, total: 1_190_000 },
  { tipo: 33, op: 'IVA Uso Común', folio: 503, neto: 100_000, ivaUc: 19_000, total: 119_000 },
  { tipo: 33, op: 'IVA no Recuperable', folio: 504, neto: 50_000, ivaNoRec: 9_500, total: 59_500 },
  { tipo: 61, op: 'Del Giro', folio: 505, neto: 10_000, iva: 1_900, total: 11_900 },
  { tipo: 33, op: 'Supermercados', folio: 506, neto: 20_000, iva: 3_800, total: 23_800 },
  { tipo: 46, op: 'Del Giro', folio: 507, neto: 30_000, iva: 5_700, total: 35_700 },
];

// ---------------------------------------------------------------------------
let e: Escenario;
const registro = new RegistroAgentes();
const como = <T>(usuarioId: string, empresaId: string, fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(usuarioId, empresaId), fn);
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) => como(e.usuarios.contadorA1.id, e.empresaA1, fn);
const comoAgente = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1, actorTipo: 'AGENTE', actorId: 'ANALISTA_TRIBUTARIO' }, fn);

const importar = (libro: 'COMPRA' | 'VENTA', anio: number, mes: number, contenido: string, seccion?: 'REGISTRO' | 'PENDIENTE') =>
  comoContador((trx) =>
    importarRcv(trx, { empresaId: e.empresaA1, libro, seccion, anio, mes, archivoNombre: `rcv-${libro}-${anio}-${mes}.csv`, contenido }),
  );

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(
    `INSERT INTO suscripciones_modulo (empresa_id, modulo_codigo, pagador, vigente_desde) VALUES ($1, 'TRIBUTARIO', 'EMPRESA', '2025-01-01')`,
    [e.empresaA1],
  );
  // UTM de julio y agosto de 2025 para el reajuste del remanente.
  await e.owner.query(
    `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente) VALUES
       ('UTM', '2025-07-01', 68647, 'Prueba', 'https://www.sii.cl/valores_y_fechas/utm/utm2025.htm'),
       ('UTM', '2025-08-01', 68785, 'Prueba', 'https://www.sii.cl/valores_y_fechas/utm/utm2025.htm'),
       ('UTM', '2025-09-01', 69265, 'Prueba', 'https://www.sii.cl/valores_y_fechas/utm/utm2025.htm')
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => {
  await e.cerrar();
});

async function errorDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('Se esperaba un error');
}

// ---------------------------------------------------------------------------
describe('Lector del RCV', () => {
  it('lee el detalle con BOM, punto y coma, comillas, tildes y fecha con hora', () => {
    const l = leerRcvCsv(csvCompras(COMPRAS_JUNIO), 'COMPRA');
    expect(l.separador).toBe(';');
    expect(l.documentos).toHaveLength(7);
    expect(l.documentos[0]).toMatchObject({
      tipo_documento: 33,
      tipo_operacion: 'DEL_GIRO',
      rut_contraparte: PROVEEDOR,
      razon_social: 'Proveedor; Ltda.',
      folio: 501,
      fecha_documento: '2026-06-15',
      fecha_recepcion: '2026-06-16',
      monto_neto: 400_000,
      monto_iva: 76_000,
    });
    expect(l.documentos[2]!.tipo_operacion).toBe('IVA_USO_COMUN');
    expect(l.documentos[3]).toMatchObject({ tipo_operacion: 'IVA_NO_RECUPERABLE', iva_no_recuperable: 9_500, codigo_iva_no_recuperable: 1 });
    // Todas las columnas del formato del SII están reconocidas (validado con un archivo real).
    expect(l.columnasNoReconocidas).toEqual([]);
    const conExtra = leerRcvCsv(csvCompras(COMPRAS_JUNIO).replace('Tasa Otro Impuesto', 'Columna Nueva'), 'COMPRA');
    expect(conExtra.columnasNoReconocidas).toEqual(['Columna Nueva']);
  });

  it('acepta coma como separador y separador de miles', () => {
    const csv = `Tipo Doc,Tipo Venta,Rut cliente,Folio,Fecha Docto,Monto Neto,Monto IVA,Monto total\n33,Del Giro,${CLIENTE},1,2026-06-01,"1.000.000",190000,1190000`;
    const l = leerRcvCsv(csv, 'VENTA');
    expect(l.documentos[0]).toMatchObject({ monto_neto: 1_000_000, monto_total: 1_190_000, fecha_documento: '2026-06-01' });
  });

  it('una nota de crédito con montos negativos se lee en valor absoluto; una factura negativa se rechaza', () => {
    const nc = `Tipo Doc;Tipo Venta;Rut cliente;Folio;Fecha Docto;Monto Neto;Monto IVA;Monto total\n61;Del Giro;${CLIENTE};3;01/06/2026;-100;-19;-119`;
    expect(leerRcvCsv(nc, 'VENTA').documentos[0]).toMatchObject({ monto_neto: 100, monto_iva: 19, monto_total: 119 });
    const factura = nc.replace('\n61;', '\n33;');
    expect(() => leerRcvCsv(factura, 'VENTA')).toThrow(/negativo/u);
  });

  it('rechaza el archivo completo si falta una columna obligatoria o una fila es inválida', () => {
    expect(() => leerRcvCsv('Tipo Doc;RUT Proveedor;Folio\n33;1-9;1', 'COMPRA')).toThrow(/Faltan columnas obligatorias/u);
    const malo = csvCompras(COMPRAS_JUNIO).replace(PROVEEDOR, '12345678-0');
    const err = (() => {
      try {
        leerRcvCsv(malo, 'COMPRA');
      } catch (x) {
        return x as ErrorNegocio;
      }
      return null;
    })();
    expect(err?.codigo).toBe('RCV_DATOS');
    expect(err?.message).toMatch(/Fila 2: RUT inválido/u);
  });

  it('no supone el tipo de operación ni acepta tipos de compra en el libro de ventas', () => {
    expect(() => leerRcvCsv(csvVentas([{ tipo: 33, op: 'Supermercados', folio: 1, total: 1 }]), 'VENTA')).toThrow(/tipo de venta no válido/u);
    expect(() => leerRcvCsv(csvCompras([{ tipo: 33, op: 'Otra cosa', folio: 1, total: 1 }]), 'COMPRA')).toThrow(/no reconocido/u);
  });

  it('rechaza documentos repetidos y fechas imposibles', () => {
    const dup = csvCompras([COMPRAS_JUNIO[0]!, COMPRAS_JUNIO[0]!]);
    expect(() => leerRcvCsv(dup, 'COMPRA')).toThrow(/repetido/u);
    expect(() => leerRcvCsv(csvCompras([COMPRAS_JUNIO[0]!], '02/2026').replace('15/02/2026', '30/02/2026'), 'COMPRA')).toThrow(
      /fecha del documento inválida/u,
    );
  });
});

describe('Importación del RCV', () => {
  it('exige el módulo Tributario y el permiso', async () => {
    await expect(
      como(e.usuarios.contadorA1.id, e.empresaA2, (trx) =>
        importarRcv(trx, { empresaId: e.empresaA2, libro: 'VENTA', anio: 2026, mes: 6, archivoNombre: 'x.csv', contenido: csvVentas(VENTAS_JUNIO) }),
      ),
    ).rejects.toThrow(/módulo Tributario/u);
    await expect(
      como(e.usuarios.gerenteA1.id, e.empresaA1, (trx) =>
        importarRcv(trx, { empresaId: e.empresaA1, libro: 'VENTA', anio: 2026, mes: 6, archivoNombre: 'x.csv', contenido: csvVentas(VENTAS_JUNIO) }),
      ),
    ).rejects.toThrow(/permiso/u);
  });

  it('no importa períodos futuros', async () => {
    await expect(importar('VENTA', 2030, 1, csvVentas(VENTAS_JUNIO))).rejects.toThrow(/período futuro/u);
  });

  it('importa, calcula totales y es idempotente con el mismo archivo', async () => {
    const v = await importar('VENTA', 2026, 6, csvVentas(VENTAS_JUNIO));
    expect(v).toMatchObject({ cantidad_documentos: 5, total_neto: '1900000', total_iva: '361000', total_exento: '300000' });
    const otra = await importar('VENTA', 2026, 6, csvVentas(VENTAS_JUNIO));
    expect(otra.importacionId).toBe(v.importacionId);
    const c = await importar('COMPRA', 2026, 6, csvCompras(COMPRAS_JUNIO));
    expect(c.cantidad_documentos).toBe(7);
  });

  it('una nueva versión del archivo reemplaza a la anterior y la deja en el historial', async () => {
    const pendientes = csvCompras([{ tipo: 33, op: 'Del Giro', folio: 900, neto: 1000, iva: 190, total: 1190 }]);
    const p1 = await importar('COMPRA', 2026, 6, pendientes, 'PENDIENTE');
    const p2 = await importar('COMPRA', 2026, 6, pendientes.replace(';900;', ';901;'), 'PENDIENTE');
    expect(p2.importacionId).not.toBe(p1.importacionId);
    const { rows } = await e.owner.query(`SELECT estado FROM rcv_importaciones WHERE id = $1`, [p1.importacionId]);
    expect(rows[0].estado).toBe('REEMPLAZADA');
  });

  it('el resumen muestra solo lo vigente, por tipo de documento; las demás personas no lo ven', async () => {
    const r = await comoContador((trx) => resumenRcv(trx, e.empresaA1, 2026, 6));
    expect(r.importaciones.map((i) => `${i.libro}/${i.seccion}`)).toEqual(['COMPRA/PENDIENTE', 'COMPRA/REGISTRO', 'VENTA/REGISTRO']);
    const ventas = r.importaciones.find((i) => i.libro === 'VENTA')!;
    expect(ventas.por_tipo.find((t) => t.tipo_documento === 61)).toMatchObject({ documentos: 1, iva: 19_000 });

    const colaborador = await como(e.usuarios.colaboradorA1.id, e.empresaA1, (trx) => resumenRcv(trx, e.empresaA1, 2026, 6));
    expect(colaborador.importaciones).toHaveLength(0);
    const otroCliente = await como(e.usuarios.adminB.id, e.empresaA1, (trx) => resumenRcv(trx, e.empresaA1, 2026, 6));
    expect(otroCliente.importaciones).toHaveLength(0);
  });

  it('los documentos importados no se modifican ni se borran, ni siquiera con el dueño de las tablas', async () => {
    await expect(e.owner.query(`UPDATE rcv_documentos SET monto_iva = 0 WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query(`DELETE FROM rcv_importaciones WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se borran/u);
    await expect(
      e.owner.query(`UPDATE rcv_importaciones SET total_iva = 1 WHERE empresa_id = $1 AND estado = 'VIGENTE'`, [e.empresaA1]),
    ).rejects.toThrow(/solo puede quedar reemplazada/u);
    await expect(
      comoContador((trx) => trx.deleteFrom('rcv_documentos' as never).execute()),
    ).rejects.toThrow(/permission denied/u);
  });
});

describe('Propuesta de F29', () => {
  let junio: string;

  it('no se prepara sin tasa de PPM, sin remanente anterior ni sin factor de uso común', async () => {
    expect(await errorDe(comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0 })))).toMatch(
      /factor de proporcionalidad/u,
    );
    expect(
      await errorDe(comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, factorProporcionalidad: 0.6 }))),
    ).toMatch(/remanente de crédito fiscal del F29 de 05-2026/u);
    expect(
      await errorDe(
        comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0, factorProporcionalidad: 0.6 })),
      ),
    ).toMatch(/tasa de PPM/u);
  });

  it('la tasa de PPM la configura una persona con permiso de aprobación', async () => {
    await expect(comoAgente((trx) => configurarTasaPpm(trx, e.empresaA1, '2025-01-01', 0.25, 'Tasa informada por el contador'))).rejects.toThrow(
      /una persona/u,
    );
    await comoContador((trx) => configurarTasaPpm(trx, e.empresaA1, '2025-01-01', 0.25, 'F22 AT2025, tasa informada por el contador'));
  });

  it('no se prepara si falta importar uno de los libros', async () => {
    expect(
      await errorDe(comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 5, remanenteAnterior: 0 }))),
    ).toMatch(/Falta importar el registro de ventas/u);
  });

  it('traspasa el RCV a los códigos del F29 con las reglas vigentes', async () => {
    junio = await comoContador((trx) =>
      prepararF29(trx, {
        empresaId: e.empresaA1,
        anio: 2026,
        mes: 6,
        remanenteAnterior: 0,
        factorProporcionalidad: 0.6,
        ajustes: [{ codigo: '151', monto: 152_500, motivo: 'Retenciones de boletas de honorarios recibidas en junio' }],
      }),
    );
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, junio));
    const c = f.codigos;
    // Débitos
    expect(c).toMatchObject({ '503': 2, '502': 285_000, '586': 1, '142': 300_000, '509': 1, '510': 19_000, '716': 1, '717': 57_000 });
    expect(c['538']).toBe(285_000 + 57_000 - 19_000);
    // Créditos: uso común al 60% (19.000 × 0,6 = 11.400), activo fijo, supermercado, nota de crédito
    expect(c).toMatchObject({ '519': 2, '520': 87_400, '524': 1, '525': 190_000, '761': 1, '762': 3_800, '527': 1, '528': 1_900 });
    expect(c).toMatchObject({ '564': 1, '521': 50_000, '504': 0 });
    expect(c['537']).toBe(87_400 + 190_000 + 3_800 - 1_900);
    expect(c['89']).toBe(323_000 - 279_300);
    expect(c['77']).toBe(0);
    // PPM: (1.000.000 + 600.000 + 200.000 − 100.000) × 0,25%
    expect(c).toMatchObject({ '563': 1_700_000, '115': 0.25, '62': 4_250 });
    expect(c['151']).toBe(152_500);
    expect(c['595']).toBe(43_700 + 4_250 + 152_500);
    expect(c['91']).toBe(200_450);
    expect(f.origen).toBe('MANUAL');
    // La factura de compra (tipo 46) no se traspasa sola y queda como advertencia; también las compras pendientes y el ajuste.
    expect(f.advertencias.map((a) => a.tipo)).toEqual([
      'FACTOR_INFORMADO',
      'DOCUMENTOS_SIN_REGLA',
      'COMPRAS_PENDIENTES',
      'REMANENTE_INFORMADO',
      'AJUSTES_MANUALES',
    ]);
    expect(JSON.stringify(f.advertencias[1])).toContain('"tipo_documento":46');
    expect(f.lineas.find((l) => l.codigo === '89')).toMatchObject({ descripcion: 'IVA determinado', valor: 43_700 });
  });

  it('los ajustes solo van a códigos permitidos, con motivo; los totales no se ajustan', async () => {
    const preparar = (ajustes: { codigo: string; monto: number; motivo: string }[]) =>
      errorDe(comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0, factorProporcionalidad: 0.6, ajustes })));
    expect(await preparar([{ codigo: '89', monto: -10_000, motivo: 'Bajar el IVA a pagar este mes' }])).toMatch(/no admite ajustes/u);
    expect(await preparar([{ codigo: '151', monto: 1000, motivo: 'corto' }])).toMatch(/motivo/u);
    expect(await preparar([{ codigo: '151', monto: 10.5, motivo: 'Monto con decimales' }])).toMatch(/entero/u);
    // El código 818 (Res. 38/2026) recién existe desde julio de 2026.
    expect(await preparar([{ codigo: '818', monto: 1000, motivo: 'Liquidación-factura como mandatario' }])).toMatch(/no admite ajustes/u);
  });

  it('las cifras de una propuesta no se modifican', async () => {
    await expect(e.owner.query(`UPDATE f29_declaraciones SET codigos = '{}' WHERE id = $1`, [junio])).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query(`DELETE FROM f29_declaraciones WHERE id = $1`, [junio])).rejects.toThrow(/no se borran/u);
  });

  it('un agente prepara, pero no aprueba', async () => {
    const id = await comoAgente((trx) =>
      prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0, factorProporcionalidad: 0.6 }),
    );
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    expect(f).toMatchObject({ origen: 'AGENTE', version: 2, estado: 'BORRADOR' });
    const anterior = await comoContador((trx) => obtenerF29(trx, e.empresaA1, junio));
    expect(anterior.estado).toBe('REEMPLAZADA');
    await expect(comoAgente((trx) => aprobarF29(trx, id, true))).rejects.toThrow(/Solo una persona/u);
    junio = id;
  });

  it('la aprobación exige confirmar las advertencias, y se invalida si el RCV cambió', async () => {
    await expect(comoContador((trx) => aprobarF29(trx, junio, false))).rejects.toThrow(/advertencia/u);
    // Se reimporta el registro de compras: la propuesta queda desactualizada.
    await importar('COMPRA', 2026, 6, csvCompras(COMPRAS_JUNIO.filter((c) => c.tipo !== 46)));
    await expect(comoContador((trx) => aprobarF29(trx, junio, true))).rejects.toThrow(/reimportó/u);
    junio = await comoContador((trx) =>
      prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0, factorProporcionalidad: 0.6 }),
    );
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, junio));
    expect(f.advertencias.map((a) => a.tipo)).toEqual(['FACTOR_INFORMADO', 'COMPRAS_PENDIENTES', 'REMANENTE_INFORMADO']);
    await comoContador((trx) => aprobarF29(trx, junio, true));
    expect((await comoContador((trx) => obtenerF29(trx, e.empresaA1, junio))).estado).toBe('APROBADA');
  });

  it('con un F29 aprobado no se reimporta el RCV ni se prepara otra versión', async () => {
    await expect(importar('VENTA', 2026, 6, csvVentas(VENTAS_JUNIO.slice(0, 2)))).rejects.toThrow(/anúlelo antes de reimportar/u);
    await expect(
      comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2026, mes: 6, remanenteAnterior: 0, factorProporcionalidad: 0.6 })),
    ).rejects.toThrow(/aprobado o declarado/u);
  });

  it('se registra la declaración con el folio del SII; un F29 declarado no se anula ni se reimporta', async () => {
    await expect(comoContador((trx) => registrarDeclaracionF29(trx, junio, '12345', '2026-06-30'))).rejects.toThrow(/posterior al período/u);
    await comoContador((trx) => registrarDeclaracionF29(trx, junio, '9876543210', '2026-07-20'));
    await expect(comoContador((trx) => anularF29(trx, junio, 'Error en las retenciones del mes'))).rejects.toThrow(/rectificatoria/u);
    await expect(importar('VENTA', 2026, 6, csvVentas(VENTAS_JUNIO.slice(0, 2)))).rejects.toThrow(/ya fue declarado/u);
    const lista = await comoContador((trx) => listarF29(trx, e.empresaA1, 2026, 6));
    expect(lista[0]).toMatchObject({ estado: 'DECLARADA', folioSii: '9876543210', totalAPagar: 43_700 + 4_250 });
  });

  it('desde julio de 2026 rigen las reglas con la línea de liquidaciones-factura (Res. 38/2026)', async () => {
    await importar('VENTA', 2026, 7, csvVentas([{ tipo: 33, op: 'Del Giro', folio: 201, neto: 100_000, iva: 19_000, total: 119_000 }], '07/2026'));
    await importar('COMPRA', 2026, 7, csvCompras([], '07/2026'));
    const id = await comoContador((trx) =>
      prepararF29(trx, {
        empresaId: e.empresaA1,
        anio: 2026,
        mes: 7,
        ajustes: [{ codigo: '818', monto: 5_000, motivo: 'IVA de liquidación-factura emitida como mandatario' }],
      }),
    );
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    // El remanente sale del F29 declarado de junio (0), y el 818 resta débito.
    expect(f.codigos).toMatchObject({ '504': 0, '502': 19_000, '818': 5_000, '538': 14_000, '89': 14_000 });
    expect((f.detalle as { normativa: { url: string } }).normativa.url).toContain('reso38');
  });
});

describe('Remanente de crédito fiscal entre meses', () => {
  it('se arrastra reajustado por la UTM y no se acepta a mano si el F29 anterior está en el sistema', async () => {
    // Julio 2025: más crédito que débito.
    await importar('VENTA', 2025, 7, csvVentas([{ tipo: 33, op: 'Del Giro', folio: 1, neto: 100_000, iva: 19_000, total: 119_000 }], '07/2025'));
    await importar('COMPRA', 2025, 7, csvCompras([{ tipo: 33, op: 'Del Giro', folio: 1, neto: 1_000_000, iva: 190_000, total: 1_190_000 }], '07/2025'));
    const julio = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 7, remanenteAnterior: 0 }));
    const fj = await comoContador((trx) => obtenerF29(trx, e.empresaA1, julio));
    expect(fj.codigos).toMatchObject({ '89': 0, '77': 171_000, '62': 250, '91': 250 });
    await comoContador((trx) => aprobarF29(trx, julio, true));

    await importar('VENTA', 2025, 8, csvVentas([{ tipo: 33, op: 'Del Giro', folio: 2, neto: 100_000, iva: 19_000, total: 119_000 }], '08/2025'));
    await importar('COMPRA', 2025, 8, csvCompras([], '08/2025'));
    await expect(
      comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 8, remanenteAnterior: 999 })),
    ).rejects.toThrow(/no se informa a mano/u);
    const agosto = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 8 }));
    const fa = await comoContador((trx) => obtenerF29(trx, e.empresaA1, agosto));
    // Art. 27 D.L. 825: el remanente de julio se convierte a la UTM de agosto (mes en que se pagaba
    // el impuesto de julio) y se reconvierte a la UTM de septiembre (mes en que se declara agosto).
    const reajustado = Math.round((171_000 * 69_265) / 68_785);
    expect(fa.codigos['504']).toBe(reajustado);
    expect(fa.codigos['77']).toBe(reajustado - 19_000);
    expect((fa.detalle as { remanente: { origen: string } }).remanente.origen).toContain('F29 de 07-2025');

    // Julio no se anula mientras agosto use su remanente.
    await expect(comoContador((trx) => anularF29(trx, julio, 'Se detectó un error en compras'))).rejects.toThrow(/mes siguiente/u);
    await comoContador((trx) => anularF29(trx, agosto, 'Se rehace después de corregir julio'));
    await comoContador((trx) => anularF29(trx, julio, 'Se detectó un error en compras'));
    expect((await comoContador((trx) => obtenerF29(trx, e.empresaA1, julio))).estado).toBe('ANULADA');
  });
});

describe('Agente Analista Tributario', () => {
  const usar = (usuarioId: string, nombre: string, entrada: unknown) =>
    ejecutarHerramienta(e.db, registro, {
      agenteCodigo: 'ANALISTA_TRIBUTARIO',
      solicitante: { usuarioId, empresaId: e.empresaA1 },
      nombre,
      entrada,
      fecha: '2026-10-29',
    });

  it('consulta el F29 y el RCV con la identidad de quien pregunta', async () => {
    const r = await usar(e.usuarios.gerenteA1.id, 'consultar_f29', { anio: 2026, mes: 6 });
    expect(r.estado).toBe('EJECUTADA');
    if (r.estado === 'EJECUTADA') {
      const res = r.resultado as { versiones: { estado: string }[]; detalle: { codigos: Record<string, number> } };
      expect(res.versiones[0]!.estado).toBe('DECLARADA');
      expect(res.detalle.codigos['89']).toBe(43_700);
    }
    const sinPermiso = await usar(e.usuarios.colaboradorA1.id, 'consultar_rcv', { anio: 2026, mes: 6 });
    expect(sinPermiso).toMatchObject({ estado: 'DENEGADA', motivo: 'SIN_PERMISO' });
  });

  it('preparar el F29 queda como propuesta si la empresa no autorizó al agente', async () => {
    const r = await usar(e.usuarios.contadorA1.id, 'preparar_f29', { anio: 2026, mes: 8, remanenteAnterior: 0 });
    expect(r).toMatchObject({ estado: 'PROPUESTA_CREADA' });
  });
});

// ---------------------------------------------------------------------------
// Hallazgos de la revisión independiente
// ---------------------------------------------------------------------------
describe('Revisión independiente: montos especiales, fechas y archivos truncados', () => {
  const ventasEspeciales = (mes: string) =>
    [
      'Tipo Doc;Tipo Venta;Rut cliente;Folio;Fecha Docto;Monto Exento;Monto Neto;Monto IVA;Monto total;IVA Retenido Total;IVA Retenido Parcial;IVA fuera de plazo;IVA Terceros',
      `33;Del Giro;${CLIENTE};301;05/${mes};0;1000000;190000;1190000;190000;0;0;0`,
      `61;Del Giro;${CLIENTE};302;06/${mes};0;100000;19000;119000;0;0;19000;0`,
    ].join('\n');

  it('el IVA retenido y las notas de crédito fuera de plazo se advierten y obligan a confirmar', async () => {
    await importar('VENTA', 2025, 1, ventasEspeciales('01/2025'));
    await importar('COMPRA', 2025, 1, csvCompras([], '01/2025'));
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 1, remanenteAnterior: 0 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, id));
    const especiales = f.advertencias.find((a) => a.tipo === 'DOCUMENTOS_CON_MONTOS_ESPECIALES');
    expect(especiales?.detalle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ concepto: 'IVA retenido (cambio de sujeto)', monto: 190_000, folios: [301] }),
        expect.objectContaining({ concepto: 'IVA de nota de crédito fuera de plazo', monto: 19_000, folios: [302] }),
      ]),
    );
    // Un remanente 0 informado a mano también se advierte.
    expect(f.advertencias.map((a) => a.tipo)).toContain('REMANENTE_INFORMADO');
    await expect(comoContador((trx) => aprobarF29(trx, id, false))).rejects.toThrow(/advertencia/u);
  });

  it('las ventas deben ser del mes y ninguna fecha puede ser posterior al período', async () => {
    await expect(importar('VENTA', 2025, 2, csvVentas(VENTAS_JUNIO))).rejects.toThrow(/fechas que no corresponden a 02-2025/u);
    await expect(importar('COMPRA', 2025, 2, csvCompras(COMPRAS_JUNIO))).rejects.toThrow(/fechas que no corresponden/u);
    // Una compra emitida antes del período, pero recibida en él, sí corresponde.
    const anterior = csvCompras([COMPRAS_JUNIO[0]!], '02/2025').replace('15/02/2025', '20/12/2024');
    await expect(importar('COMPRA', 2025, 2, anterior)).resolves.toMatchObject({ cantidad_documentos: 1 });
  });

  it('una fila truncada o sin total se rechaza; un total que no cuadra se advierte', () => {
    const base = `Tipo Doc;Tipo Venta;Rut cliente;Folio;Fecha Docto;Monto Neto;Monto IVA;Monto total\n`;
    expect(() => leerRcvCsv(`${base}33;Del Giro;${CLIENTE};1;01/06/2026;1000000;190000`, 'VENTA')).toThrow(/columnas/u);
    expect(() => leerRcvCsv(`${base}33;Del Giro;${CLIENTE};1;01/06/2026;1000000;190000;`, 'VENTA')).toThrow(/falta el monto total/u);
    const l = leerRcvCsv(`${base}33;Del Giro;${CLIENTE};1;01/06/2026;1000000;190000;5;`, 'VENTA');
    expect(l.advertencias[0]).toMatch(/Fila 2 \(folio 1\): el total 5 no es la suma/u);
    expect(() => leerRcvCsv(`${base}33;Del Giro;${CLIENTE};1;01/06/2026;1000000000000;0;1000000000000`, 'VENTA')).toThrow(/monto inválido/u);
  });

  it('la base de datos rechaza importaciones nulas y el origen ROBOT_SII declarado por una persona', async () => {
    const llamar = (origen: string, docs: string | null) =>
      comoContador((trx) =>
        sql`SELECT rcv_registrar_importacion(${e.empresaA1}::uuid, 'VENTA', 'REGISTRO', 2025, 3, ${origen}, 'x.csv',
              ${'a'.repeat(64)}, ${docs}::jsonb)`.execute(trx),
      );
    await expect(llamar('ARCHIVO_SII', null)).rejects.toThrow(/Documentos inválidos/u);
    await expect(llamar('ROBOT_SII', '[]')).rejects.toThrow(/proceso del sistema/u);
  });

  it('un ajuste sin monto se rechaza en la base de datos', async () => {
    await expect(
      comoContador((trx) =>
        sql`SELECT f29_preparar(${e.empresaA1}::uuid, 2025, 1, 0, NULL, '[{"codigo": "151", "motivo": "Sin monto informado"}]'::jsonb)`.execute(trx),
      ),
    ).rejects.toThrow(/monto inválido/u);
  });
});

describe('Revisión independiente: concurrencia y cadena de remanentes', () => {
  const prepararMes = async (anio: number, mes: number, remanenteAnterior?: number) => {
    const m = `${String(mes).padStart(2, '0')}/${anio}`;
    await importar('VENTA', anio, mes, csvVentas([{ tipo: 33, op: 'Del Giro', folio: 400 + mes, neto: 100_000, iva: 19_000, total: 119_000 }], m));
    await importar('COMPRA', anio, mes, csvCompras([], m));
    return comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio, mes, remanenteAnterior }));
  };
  const diferido = () => {
    let resolver!: () => void;
    const promesa = new Promise<void>((r) => (resolver = r));
    return { promesa, resolver };
  };

  it('aprobar espera a una reimportación en curso y luego exige preparar de nuevo', async () => {
    const id = await prepararMes(2025, 3, 0);
    const importado = diferido();
    const soltar = diferido();
    const a = comoContador(async (trx) => {
      await importarRcv(trx, {
        empresaId: e.empresaA1, libro: 'COMPRA', anio: 2025, mes: 3, archivoNombre: 'nuevo.csv',
        contenido: csvCompras([{ tipo: 33, op: 'Del Giro', folio: 1, neto: 1000, iva: 190, total: 1190 }], '03/2025'),
      });
      importado.resolver();
      await soltar.promesa;
    });
    await importado.promesa;
    const b = comoContador((trx) => aprobarF29(trx, id, true));
    await new Promise((r) => setTimeout(r, 200));
    soltar.resolver();
    await a;
    await expect(b).rejects.toThrow(/reimportó/u);
  });

  it('anular un mes espera a que termine la preparación del siguiente y luego la respeta', async () => {
    const mayo = await prepararMes(2025, 5, 0);
    await comoContador((trx) => aprobarF29(trx, mayo, true));
    await importar('VENTA', 2025, 6, csvVentas([], '06/2025'));
    await importar('COMPRA', 2025, 6, csvCompras([], '06/2025'));
    const preparado = diferido();
    const soltar = diferido();
    const a = comoContador(async (trx) => {
      await prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 6 });
      preparado.resolver();
      await soltar.promesa;
    });
    await preparado.promesa;
    const b = comoContador((trx) => anularF29(trx, mayo, 'Error detectado en las ventas'));
    await new Promise((r) => setTimeout(r, 200));
    soltar.resolver();
    await a;
    await expect(b).rejects.toThrow(/mes siguiente/u);
  });

  it('no se informa el remanente a mano si el mes anterior tiene un F29 en el sistema', async () => {
    await prepararMes(2025, 10, 0);
    await expect(prepararMes(2025, 11, 0)).rejects.toThrow(/10-2025 está en borrador/u);
    // Enero se prepara con remanente a mano; si después aparece diciembre, enero debe rehacerse.
    const enero = await prepararMes(2026, 1, 0);
    await prepararMes(2025, 12, 0);
    await expect(comoContador((trx) => aprobarF29(trx, enero, true))).rejects.toThrow(/mes anterior en el sistema/u);
  });

  it('la propuesta del agente aprobada por una persona queda con origen AGENTE_APROBADO', async () => {
    const r = await ejecutarHerramienta(e.db, registro, {
      agenteCodigo: 'ANALISTA_TRIBUTARIO',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      nombre: 'preparar_f29',
      entrada: { anio: 2025, mes: 1, remanenteAnterior: 0 },
      fecha: '2026-10-29',
    });
    expect(r.estado).toBe('PROPUESTA_CREADA');
    if (r.estado !== 'PROPUESTA_CREADA') return;
    const resuelta = await resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, r.propuestaId, 'APROBAR');
    expect(resuelta.estado).toBe('EJECUTADA');
    const f = resuelta.resultado as { origen: string; advertencias: { tipo: string; mensaje: string }[] };
    expect(f.origen).toBe('AGENTE_APROBADO');
    expect(f.advertencias.find((a) => a.tipo === 'REMANENTE_INFORMADO')?.mensaje).toMatch(/al agente/u);
  });

  it('una tasa de PPM mal digitada se reemplaza con motivo, y las propuestas previas deben rehacerse', async () => {
    const id = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 3, remanenteAnterior: 0 }));
    await expect(comoContador((trx) => configurarTasaPpm(trx, e.empresaA1, '2025-01-01', 0.3, 'Tasa corregida'))).rejects.toThrow(
      /motivo del reemplazo/u,
    );
    await comoContador((trx) =>
      configurarTasaPpm(trx, e.empresaA1, '2025-01-01', 0.3, 'Tasa corregida según F22', 'Se digitó 0,25 en vez de 0,3'),
    );
    await expect(comoContador((trx) => aprobarF29(trx, id, true))).rejects.toThrow(/tasa de PPM cambió/u);
    const nuevo = await comoContador((trx) => prepararF29(trx, { empresaId: e.empresaA1, anio: 2025, mes: 3, remanenteAnterior: 0 }));
    const f = await comoContador((trx) => obtenerF29(trx, e.empresaA1, nuevo));
    expect(f.codigos['115']).toBe(0.3);
    await expect(e.owner.query(`DELETE FROM tributario_tasas_ppm WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifica/u);
  });
});
