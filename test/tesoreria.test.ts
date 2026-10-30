import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { ejecutarHerramienta, resolverPropuesta } from '../src/agentes/ejecutor.js';
import { crearEjercicio, registrarAsiento, reversarAsiento } from '../src/contabilidad/libroDiario.js';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { leerCartola, rutEnDescripcion } from '../src/tesoreria/cartola.js';
import {
  anularConciliacion,
  conciliar,
  contabilizarMovimiento,
  crearCuentaBancaria,
  crearRegla,
  importarCartola,
  informeConciliacion,
  lineasBanco,
  listarMovimientos,
  sugerirConciliacion,
} from '../src/tesoreria/conciliacion.js';
import { importarRcv } from '../src/tributario/rcv.js';
import { leerXls } from '../src/utilidades/xls.js';
import { crearEscenario, type Escenario } from './escenario.js';

/*
 * Conciliación bancaria con una réplica anonimizada de la cartola real de Scotiabank de
 * septiembre de 2026 (mismo formato .xls, fechas y montos; nombres, RUT y cuenta ficticios).
 */
const CARTOLA = readFileSync(new URL('./datos/cartola_scotiabank_sep2026.xls', import.meta.url));
const GRANDE = readFileSync(new URL('./datos/cartola_grande.xls', import.meta.url));
const CLIENTE = '76111222-8';
const SOCIO = '12345678-5';
const OTRA_PERSONA = '11222333-9';

let e: Escenario;
let cuenta: string;
const registro = new RegistroAgentes();
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);

beforeAll(async () => {
  e = await crearEscenario();
  for (const m of ['TESORERIA', 'TRIBUTARIO']) {
    await e.owner.query(
      `INSERT INTO suscripciones_modulo (empresa_id, modulo_codigo, pagador, vigente_desde) VALUES ($1, $2, 'EMPRESA', '2026-01-01')`,
      [e.empresaA1, m],
    );
  }
  // Plan de cuentas adicional: clientes, cuenta corriente del socio, capital e ingresos.
  const cuentas: Array<[string, string, string, string, boolean, boolean, string | null]> = [
    ['1.1.03', 'Clientes', 'ACTIVO', 'DEUDORA', true, true, '1.1'],
    ['2', 'Pasivo', 'PASIVO', 'ACREEDORA', false, false, null],
    ['2.1', 'Pasivo corriente', 'PASIVO', 'ACREEDORA', false, false, '2'],
    ['2.1.01', 'Cuenta corriente socios', 'PASIVO', 'ACREEDORA', true, true, '2.1'],
    ['3', 'Patrimonio', 'PATRIMONIO', 'ACREEDORA', false, false, null],
    ['3.1.01', 'Capital', 'PATRIMONIO', 'ACREEDORA', true, false, '3'],
  ];
  for (const [codigo, nombre, clasificacion, naturaleza, imputable, tercero, padre] of cuentas) {
    await e.owner.query(
      `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable, requiere_tercero, padre_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT id FROM plan_cuentas WHERE empresa_id = $1 AND codigo = $8))`,
      [e.empresaA1, codigo, nombre, clasificacion, naturaleza, imputable, tercero, padre],
    );
  }
  for (const [rut, nombre] of [
    [CLIENTE, 'Cliente de Prueba SpA'],
    [SOCIO, 'Socio Uno'],
    [OTRA_PERSONA, 'Persona Dos'],
  ]) {
    await e.owner.query(`INSERT INTO terceros (empresa_id, rut, razon_social) VALUES ($1, $2, $3)`, [e.empresaA1, rut, nombre]);
  }
  await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2026));
});
afterAll(async () => {
  await e.cerrar();
});

describe('Lector de planillas .xls y de cartolas', () => {
  it('lee la cartola de Scotiabank: cabecera, movimientos, RUT de la contraparte y saldos', () => {
    const c = leerCartola(CARTOLA);
    expect(c.formato).toBe('SCOTIABANK_XLS');
    expect(c.cabecera).toEqual({
      numero_cuenta: '1234567890',
      moneda: 'CLP',
      numero_estado: 14,
      desde: '2026-09-01',
      hasta: '2026-09-28',
      saldo_anterior: 81_000,
      total_abonos: 3_750_000,
      total_cargos: 3_041_000,
      saldo_final: 790_000,
    });
    expect(c.movimientos).toHaveLength(12);
    expect(c.movimientos[0]).toMatchObject({ fecha: '2026-09-01', monto: 3_750_000, saldo: 3_831_000, rut_contraparte: CLIENTE });
    expect(c.movimientos[1]).toMatchObject({ monto: -1_300_000, saldo: 2_531_000, rut_contraparte: SOCIO, numero_documento: null });
  });

  it('lee planillas con la tabla de textos partida en varios registros (400 movimientos, tildes y Ñ)', () => {
    const filas = leerXls(GRANDE);
    expect(filas).toHaveLength(411);
    expect(filas[11]![1]).toBe('PAGO PROVEEDOR NUMERO 0000 CON DESCRIPCION LARGA ÑANDÚ');
    const c = leerCartola(GRANDE);
    expect(c.movimientos).toHaveLength(400);
    expect(c.cabecera.total_cargos).toBe(c.movimientos.reduce((s, m) => s - m.monto, 0));
  });

  it('rechaza archivos dañados, monedas extranjeras y filas con cargo y abono', () => {
    const danado = Buffer.from(CARTOLA);
    danado.fill(0xff, 600, 2000);
    expect(() => leerCartola(danado)).toThrow(/planilla/u);
    const csv = (fila: string, moneda = 'CLP') =>
      Buffer.from(`Saldo Anterior;1000\nMoneda;${moneda}\nFecha;Descripción;Cargo;Abono;Saldo Diario\n${fila}\n`);
    expect(leerCartola(csv('01-09-2026;Depósito;;500;1500')).cabecera).toMatchObject({ saldo_final: 1500, desde: '2026-09-01' });
    expect(() => leerCartola(csv('01-09-2026;Algo;-100;500;1400'))).toThrow(/cargo o un abono/u);
    expect(() => leerCartola(csv('01-09-2026;Depósito;;500;1500', 'USD'))).toThrow(/pesos chilenos/u);
    expect(() => leerCartola(Buffer.from('Fecha;Descripción;Cargo;Abono\n01-09-2026;Depósito;;500\n'))).toThrow(/saldo final o el saldo diario/u);
    expect(() => leerCartola(csv('01-09-2026;Reversa;;-500;500'))).toThrow(/abono negativo/u);
    // Una planilla más ancha que una cartola se rechaza antes de reservar memoria.
    expect(() => leerXls(readFileSync(new URL('./datos/planilla_ancha.xls', import.meta.url)))).toThrow(/excede/u);
  });

  it('reconoce el RUT en la descripción solo si es válido', () => {
    expect(rutEnDescripcion('TEF 76.111.222-8 CLIENTE')).toBe(CLIENTE);
    expect(rutEnDescripcion('TEF 76111222-1 CLIENTE')).toBeNull();
    expect(rutEnDescripcion('PAGO 123')).toBeNull();
  });
});

describe('Cuentas bancarias y cartolas', () => {
  it('la cuenta bancaria va contra una cuenta contable de activo imputable', async () => {
    await expect(
      comoContador((trx) => crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'SCOTIABANK', numero: '1234567890', cuentaContable: '2.1.01' })),
    ).rejects.toThrow(/de activo/u);
    cuenta = await comoContador((trx) =>
      crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'SCOTIABANK', numero: '12-3456-7890', cuentaContable: '1.1.02' }),
    );
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA2), (trx) =>
        crearCuentaBancaria(trx, { empresaId: e.empresaA2, banco: 'BCI', numero: '11112222', cuentaContable: '1.1.02' }),
      ),
    ).rejects.toThrow(/Tesorería/u);
  });

  it('importa la cartola; el mismo archivo no se duplica; una cartola de otra cuenta se rechaza', async () => {
    const r = await comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: cuenta, archivoNombre: 'sep.xls', contenido: CARTOLA }));
    expect(r).toMatchObject({ movimientos: 12, nuevos: 12, ya_importada: false, advertencias: [] });
    const otra = await comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: cuenta, archivoNombre: 'sep.xls', contenido: CARTOLA }));
    expect(otra).toMatchObject({ cartola_id: r.cartola_id, ya_importada: true, nuevos: 0 });

    const segunda = await comoContador((trx) =>
      crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'BANCO_ESTADO', numero: '99887766', cuentaContable: '1.1.01' }),
    );
    await expect(
      comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: segunda, archivoNombre: 'sep.xls', contenido: CARTOLA })),
    ).rejects.toThrow(/cuenta 1234567890/u);
  });

  it('la base de datos rechaza una cartola que no cuadra o con saldos diarios alterados', async () => {
    const c = leerCartola(CARTOLA);
    const llamar = (cabecera: object, movimientos: object[]) =>
      comoContador((trx) =>
        sql`SELECT tesoreria_registrar_cartola(${e.empresaA1}::uuid, ${cuenta}::uuid, 'TABLA_GENERICA', 'x.csv', ${'c'.repeat(64)},
              ${JSON.stringify(cabecera)}::jsonb, ${JSON.stringify(movimientos)}::jsonb)`.execute(trx),
      );
    await expect(llamar({ ...c.cabecera, saldo_final: 790_001 }, c.movimientos)).rejects.toThrow(/no cuadra/u);
    const alterados = c.movimientos.map((m, i) => (i === 3 ? { ...m, saldo: (m.saldo ?? 0) + 1 } : m));
    await expect(llamar(c.cabecera, alterados)).rejects.toThrow(/saldo diario/u);
    const fuera = c.movimientos.map((m, i) => (i === 0 ? { ...m, fecha: '2026-10-01' } : m));
    await expect(llamar(c.cabecera, fuera)).rejects.toThrow(/fuera del período/u);
  });

  it('una cartola que se traslapa solo agrega los movimientos nuevos', async () => {
    const csv = Buffer.from(
      [
        'Numero Cuenta;1234567890',
        'Moneda;CLP',
        'Fecha Desde;25-09-2026',
        'Fecha Hasta;30-09-2026',
        'Saldo Anterior;920000',
        'Fecha;Descripción;Cargo;Abono;Saldo Diario',
        `25-09-2026;TEF ${SOCIO} Socio Uno Prueba;-80000;;840000`,
        `28-09-2026;TEF ${SOCIO} Socio Uno Prueba;-50000;;790000`,
        `29-09-2026;TEF ${SOCIO} Socio Uno Prueba;-50000;;740000`,
        `30-09-2026;COMISION MANTENCION;-5000;;735000`,
      ].join('\n'),
    );
    const r = await comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: cuenta, archivoNombre: 'fin-sep.csv', contenido: csv }));
    expect(r).toMatchObject({ movimientos: 4, nuevos: 2, formato: 'TABLA_GENERICA' });
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, cuenta));
    expect(movs).toHaveLength(14);
  });
});

describe('Conciliación', () => {
  it('sugiere según asientos, reglas y el RCV, sin escribir nada', async () => {
    // Ventas de agosto (las dos facturas del cliente por $3.750.000).
    await comoContador((trx) =>
      importarRcv(trx, {
        empresaId: e.empresaA1,
        libro: 'VENTA',
        anio: 2026,
        mes: 8,
        archivoNombre: 'ventas.csv',
        contenido: readFileSync(new URL('./datos/rcv_venta_detalle_sii.csv', import.meta.url), 'utf8'),
      }),
    );
    // Saldo inicial y una transferencia ya contabilizada.
    await comoContador((trx) =>
      registrarAsiento(trx, {
        empresaId: e.empresaA1,
        fecha: '2026-01-01',
        glosa: 'Saldo inicial del banco',
        lineas: [
          { cuenta: '1.1.02', debe: 81_000 },
          { cuenta: '3.1.01', haber: 81_000 },
        ],
      }),
    );
    await comoContador((trx) =>
      registrarAsiento(trx, {
        empresaId: e.empresaA1,
        fecha: '2026-09-01',
        glosa: 'Transferencia al socio',
        lineas: [
          { cuenta: '2.1.01', debe: 1_300_000, tercero: SOCIO },
          { cuenta: '1.1.02', haber: 1_300_000 },
        ],
      }),
    );
    await comoContador((trx) =>
      crearRegla(trx, {
        empresaId: e.empresaA1,
        nombre: 'Transferencias al socio',
        rut: SOCIO,
        sentido: 'CARGO',
        destino: '2.1.01',
        tercero: SOCIO,
        glosa: 'Transferencia al socio (cuenta corriente)',
      }),
    );
    const s = await comoContador((trx) => sugerirConciliacion(trx, e.empresaA1, cuenta, '2026-09-30'));
    const porMonto = (monto: number) => s.sugerencias.find((x) => s.movimientos.find((m) => m.id === x.movimientoId)!.monto === monto)!;
    expect(porMonto(3_750_000)).toMatchObject({ tipo: 'SIN_SUGERENCIA', evidencia: [{ folio: 56 }, { folio: 55 }] });
    expect(porMonto(-1_300_000)).toMatchObject({ tipo: 'CONCILIAR', confianza: 'ALTA' });
    expect(porMonto(-1_000_000)).toMatchObject({ tipo: 'CONTABILIZAR', regla: { cuentaContable: '2.1.01', tercero: SOCIO } });
    expect(porMonto(-5_000)).toMatchObject({ tipo: 'SIN_SUGERENCIA' });
    const { rows } = await e.owner.query(`SELECT count(*)::int AS n FROM conciliaciones WHERE empresa_id = $1`, [e.empresaA1]);
    expect(rows[0].n).toBe(0);
  });

  it('concilia solo si cuadra exactamente y sin repetir', async () => {
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, cuenta, { soloPendientes: true }));
    const lineas = await comoContador((trx) => lineasBanco(trx, e.empresaA1, cuenta, '2026-09-30'));
    const transferencia = movs.find((m) => m.monto === -1_300_000)!;
    const linea = lineas.find((l) => l.monto === -1_300_000)!;
    const otra = movs.find((m) => m.monto === -50_000)!;
    await expect(comoContador((trx) => conciliar(trx, e.empresaA1, [otra.id], [linea.linea_id]))).rejects.toThrow(/No cuadra/u);
    const inicial = lineas.find((l) => l.monto === 81_000)!;
    await expect(comoContador((trx) => conciliar(trx, e.empresaA1, [transferencia.id], [inicial.linea_id]))).rejects.toThrow(/No cuadra/u);
    await comoContador((trx) => conciliar(trx, e.empresaA1, [transferencia.id], [linea.linea_id]));
    await expect(comoContador((trx) => conciliar(trx, e.empresaA1, [transferencia.id], [linea.linea_id]))).rejects.toThrow(/ya está conciliado/u);
  });

  it('contabiliza un movimiento (asiento + conciliación) con las validaciones del libro diario', async () => {
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, cuenta, { soloPendientes: true }));
    const cobro = movs.find((m) => m.monto === 3_750_000)!;
    await expect(
      comoContador((trx) =>
        contabilizarMovimiento(trx, { empresaId: e.empresaA1, movimientoId: cobro.id, cuentaContable: '1.1.03', glosa: 'Cobro factura 56' }),
      ),
    ).rejects.toThrow(/tercero/u);
    const r = await comoContador((trx) =>
      contabilizarMovimiento(trx, {
        empresaId: e.empresaA1,
        movimientoId: cobro.id,
        cuentaContable: '1.1.03',
        tercero: CLIENTE,
        glosa: 'Cobro factura exenta 56',
      }),
    );
    expect(r.numero).toBeGreaterThan(0);
    const lineas = await comoContador((trx) => lineasBanco(trx, e.empresaA1, cuenta, '2026-09-30'));
    expect(lineas.find((l) => l.asiento_id === r.asientoId)).toMatchObject({ monto: 3_750_000, conciliacion_id: r.conciliacionId });
  });

  it('el informe muestra saldo del banco, saldo contable, partidas pendientes y diferencia', async () => {
    const i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, cuenta, '2026-09-30'));
    expect(i.saldoBanco).toBe(735_000);
    // Libros: 81.000 − 1.300.000 + 3.750.000
    expect(i.saldoLibros).toBe(2_531_000);
    expect(i.movimientosNoContabilizados).toHaveLength(12);
    expect(i.partidasNoCobradasEnBanco).toHaveLength(0);
    expect(i.diferencia).toBe(0);
    expect(i.cuadra).toBe(true);
  });

  it('un agente propone contabilizar; al aprobarlo, la conciliación queda con origen AGENTE_APROBADO', async () => {
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, cuenta, { soloPendientes: true }));
    const retiro = movs.find((m) => m.monto === -1_000_000)!;
    const usar = (usuarioId: string, nombre: string, entrada: unknown) =>
      ejecutarHerramienta(e.db, registro, { agenteCodigo: 'TESORERO', solicitante: { usuarioId, empresaId: e.empresaA1 }, nombre, entrada, fecha: '2026-10-30' });
    expect(await usar(e.usuarios.colaboradorA1.id, 'consultar_conciliacion_bancaria', { cuentaId: cuenta, corte: '2026-09-30' })).toMatchObject({
      estado: 'DENEGADA',
      motivo: 'SIN_PERMISO',
    });
    const p = await usar(e.usuarios.contadorA1.id, 'proponer_contabilizar_movimiento', {
      movimientoId: retiro.id,
      cuentaContable: '2.1.01',
      tercero: SOCIO,
      glosa: 'Transferencia al socio (cuenta corriente)',
    });
    expect(p.estado).toBe('PROPUESTA_CREADA');
    if (p.estado !== 'PROPUESTA_CREADA') return;
    const r = await resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, p.propuestaId, 'APROBAR');
    expect(r.estado).toBe('EJECUTADA');
    const { conciliacionId } = r.resultado as { conciliacionId: string };
    const { rows } = await e.owner.query(`SELECT origen FROM conciliaciones WHERE id = $1`, [conciliacionId]);
    expect(rows[0].origen).toBe('AGENTE_APROBADO');
  });

  it('anular una conciliación libera el movimiento; un asiento reversado se advierte y no se concilia', async () => {
    const lineas = await comoContador((trx) => lineasBanco(trx, e.empresaA1, cuenta, '2026-09-30'));
    const cobro = lineas.find((l) => l.monto === 3_750_000)!;
    await comoContador((trx) => reversarAsiento(trx, cobro.asiento_id, '2026-09-30', 'Se registró en la cuenta equivocada'));
    const i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, cuenta, '2026-09-30'));
    expect(i.advertencias.join(' ')).toMatch(/asiento que después se reversó/u);
    await comoContador((trx) => anularConciliacion(trx, cobro.conciliacion_id!, 'El asiento del cobro se reversó'));
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, cuenta, { soloPendientes: true }));
    const mov = movs.find((m) => m.monto === 3_750_000)!;
    await expect(comoContador((trx) => conciliar(trx, e.empresaA1, [mov.id], [cobro.linea_id]))).rejects.toThrow(/reversados/u);
    const despues = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, cuenta, '2026-09-30'));
    expect(despues.diferencia).toBe(0);
    expect(despues.advertencias).toEqual([]);
  });

  it('cartolas, movimientos y conciliaciones no se modifican ni se borran; otro cliente no los ve', async () => {
    await expect(e.owner.query(`UPDATE movimientos_bancarios SET monto = 1 WHERE cuenta_id = $1`, [cuenta])).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query(`DELETE FROM conciliaciones WHERE cuenta_id = $1`, [cuenta])).rejects.toThrow(/no se borran/u);
    await expect(e.owner.query(`UPDATE cartolas SET saldo_final = 0 WHERE cuenta_id = $1`, [cuenta])).rejects.toThrow(/no se modifican/u);
    const ajeno = await enContexto(e.db, contextoDeUsuario(e.usuarios.adminB.id, e.empresaA1), (trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM movimientos_bancarios`.execute(trx),
    );
    expect(ajeno.rows[0]!.n).toBe(0);
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.adminB.id, e.empresaA1), (trx) => listarMovimientos(trx, e.empresaA1, cuenta)),
    ).resolves.toEqual([]);
  });

  it('advierte cartolas discontinuas', async () => {
    const csv = Buffer.from(
      ['Numero Cuenta;1234567890', 'Fecha Desde;01-10-2026', 'Fecha Hasta;10-10-2026', 'Saldo Anterior;700000',
       'Fecha;Descripción;Cargo;Abono;Saldo Diario', '05-10-2026;DEPOSITO;;10000;710000'].join('\n'),
    );
    const r = await comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: cuenta, archivoNombre: 'oct.csv', contenido: csv }));
    expect(r.advertencias).toEqual([expect.objectContaining({ tipo: 'CARTOLAS_DISCONTINUAS' })]);
  });
});

describe('Revisión independiente: conciliación al corte, años sin cerrar y cartolas que no calzan', () => {
  let bci: string;
  let cuentaAnio: string;
  const importar = (cuentaId: string, lineas: string[], nombre: string) =>
    comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId, archivoNombre: nombre, contenido: Buffer.from(lineas.join('\n')) }));
  const asiento = (fecha: string, monto: number, cuenta: string, glosa: string) =>
    comoContador((trx) =>
      registrarAsiento(trx, {
        empresaId: e.empresaA1,
        fecha,
        glosa,
        lineas:
          monto > 0
            ? [{ cuenta, debe: monto }, { cuenta: '3.1.01', haber: monto }]
            : [{ cuenta: '3.1.01', debe: -monto }, { cuenta, haber: -monto }],
      }),
    );

  beforeAll(async () => {
    for (const codigo of ['1.1.04', '1.1.05']) {
      await e.owner.query(
        `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable, padre_id)
         VALUES ($1, $2, 'Banco de prueba', 'ACTIVO', 'DEUDORA', true, (SELECT id FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '1.1'))`,
        [e.empresaA1, codigo],
      );
    }
    bci = await comoContador((trx) => crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'BCI', numero: '55554444', cuentaContable: '1.1.04' }));
    cuentaAnio = await comoContador((trx) =>
      crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'SANTANDER', numero: '33332222', cuentaContable: '1.1.05' }),
    );
  });

  it('un depósito en tránsito y un cheque anterior al inicio se informan al corte', async () => {
    await asiento('2026-07-01', 5_000, '1.1.04', 'Saldo inicial BCI');
    await asiento('2026-07-25', -300, '1.1.04', 'Cheque girado en julio');
    await importar(
      bci,
      ['Numero Cuenta;55554444', 'Fecha Desde;01-08-2026', 'Fecha Hasta;31-08-2026', 'Saldo Anterior;5000',
       'Fecha;Descripción;Cargo;Abono;Saldo Diario', '10-08-2026;CHEQUE 15;-300;;4700', '31-08-2026;DEPOSITO;;1000;5700'],
      'bci-ago.csv',
    );
    // El depósito se contabiliza el 02-09 (después del corte) y se concilia.
    await asiento('2026-09-02', 1_000, '1.1.04', 'Depósito del 31-08');
    const lineas = await comoContador((trx) => lineasBanco(trx, e.empresaA1, bci, '2026-09-30'));
    const movs = await comoContador((trx) => listarMovimientos(trx, e.empresaA1, bci));
    await comoContador((trx) =>
      conciliar(trx, e.empresaA1, [movs.find((m) => m.monto === 1_000)!.id], [lineas.find((l) => l.fecha === '2026-09-02')!.linea_id]),
    );

    let i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, bci, '2026-08-31'));
    expect(i).toMatchObject({ saldoBanco: 5_700, saldoLibros: 4_700, diferenciaInicialPendiente: -300, diferencia: 0, cuadra: false });
    expect(i.movimientosNoContabilizados.map((m) => m.monto).sort()).toEqual([-300, 1_000]);
    expect(i.advertencias.join(' ')).toMatch(/diferían en \$-300/u);

    // Se concilia el cheque de julio con su cobro de agosto: la diferencia inicial queda aclarada.
    await comoContador((trx) =>
      conciliar(trx, e.empresaA1, [movs.find((m) => m.monto === -300)!.id], [lineas.find((l) => l.fecha === '2026-07-25')!.linea_id]),
    );
    i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, bci, '2026-08-31'));
    expect(i).toMatchObject({ diferenciaInicialPendiente: 0, diferencia: 0, cuadra: true });
    expect(i.movimientosNoContabilizados.map((m) => m.monto)).toEqual([1_000]);
  });

  it('un asiento reversado después del corte sigue vigente al corte', async () => {
    const cheque = await asiento('2026-08-20', -700, '1.1.04', 'Cheque anulado después');
    await comoContador((trx) => reversarAsiento(trx, cheque.id, '2026-09-05', 'Cheque anulado en septiembre'));
    const i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, bci, '2026-08-31'));
    expect(i.partidasNoCobradasEnBanco.map((l) => l.monto)).toEqual([-700]);
    expect(i.diferencia).toBe(0);
  });

  it('el saldo contable incluye el año anterior aunque no esté cerrado', async () => {
    await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2025));
    await asiento('2025-12-15', 5_000, '1.1.05', 'Depósito de diciembre');
    await importar(
      cuentaAnio,
      ['Numero Cuenta;33332222', 'Fecha Desde;01-01-2026', 'Fecha Hasta;31-01-2026', 'Saldo Anterior;5000', 'Saldo Actual;5000',
       'Fecha;Descripción;Cargo;Abono;Saldo Diario'],
      'santander-ene.csv',
    );
    const i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, cuentaAnio, '2026-01-31'));
    expect(i).toMatchObject({ saldoBanco: 5_000, saldoLibros: 5_000, diferencia: 0, cuadra: true });
  });

  it('una cartola que contradice los movimientos ya importados se rechaza; mayúsculas y espacios no duplican', async () => {
    // Igual a la de agosto, pero con distinta mayúscula y espacios: no agrega nada.
    const r = await importar(
      bci,
      ['Numero Cuenta;55554444', 'Fecha Desde;10-08-2026', 'Fecha Hasta;31-08-2026', 'Saldo Anterior;5000',
       'Fecha;Descripción;Cargo;Abono;Saldo Diario', '10-08-2026;cheque  15;-300;;4700', '31-08-2026;Deposito;;1000;5700'],
      'bci-ago-2.csv',
    );
    expect(r.nuevos).toBe(0);
    // Una cartola parcial que trae otro movimiento para días ya cubiertos no calza.
    await expect(
      importar(
        bci,
        ['Numero Cuenta;55554444', 'Fecha Desde;31-08-2026', 'Fecha Hasta;31-08-2026', 'Saldo Anterior;4700',
         'Fecha;Descripción;Cargo;Abono;Saldo Diario', '31-08-2026;COMISION;-100;;4600'],
        'bci-parcial.csv',
      ),
    ).rejects.toThrow(/no calza/u);
  });

  it('no se concilian grupos de neto cero', async () => {
    await importar(
      bci,
      ['Numero Cuenta;55554444', 'Fecha Desde;01-09-2026', 'Fecha Hasta;03-09-2026', 'Saldo Anterior;5700',
       'Fecha;Descripción;Cargo;Abono;Saldo Diario', '01-09-2026;ABONO X;;100;5800', '03-09-2026;CARGO Y;-100;;5700'],
      'bci-sep.csv',
    );
    const movs = (await comoContador((trx) => listarMovimientos(trx, e.empresaA1, bci, { soloPendientes: true }))).filter((m) => m.fecha >= '2026-09-01');
    const a = await asiento('2026-09-01', 777, '1.1.04', 'Partida A');
    const b = await asiento('2026-09-02', -777, '1.1.04', 'Partida B');
    const lineas = (await comoContador((trx) => lineasBanco(trx, e.empresaA1, bci, '2026-09-30'))).filter((l) => [a.id, b.id].includes(l.asiento_id));
    await expect(comoContador((trx) => conciliar(trx, e.empresaA1, movs.map((m) => m.id), lineas.map((l) => l.linea_id)))).rejects.toThrow(/neto cero/u);
  });
});
