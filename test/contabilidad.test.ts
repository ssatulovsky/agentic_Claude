import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { ejecutarHerramienta, resolverPropuesta } from '../src/agentes/ejecutor.js';
import {
  cerrarEjercicio,
  cerrarPeriodo,
  crearEjercicio,
  listarEjercicios,
  obtenerAsiento,
  reabrirPeriodo,
  registrarAsiento,
  resolverReaperturaEjercicio,
  reversarAsiento,
  solicitarReaperturaEjercicio,
  type LineaAsiento,
} from '../src/contabilidad/libroDiario.js';
import { balanceOchoColumnas, libroMayor } from '../src/contabilidad/reportes.js';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { aCentavos, deCentavos, formatoPesos } from '../src/utilidades/montos.js';
import { crearEscenario, rutAleatorio, type Escenario } from './escenario.js';

/*
 * El flujo principal usa el ejercicio 2025: todos sus meses ya terminaron, así
 * que se pueden cerrar (la base de datos no permite cerrar un mes en curso).
 */

let e: Escenario;
let rutProveedor: string;
let ej2025: string;
const directores: string[] = [];
let directorSinMfa: string;

const como = <T>(usuarioId: string, fn: (trx: Trx) => Promise<T>, empresaId?: string) =>
  enContexto(e.db, contextoDeUsuario(usuarioId, empresaId ?? e.empresaA1), fn);
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) => como(e.usuarios.contadorA1.id, fn);
const asiento = (fecha: string, glosa: string, lineas: LineaAsiento[], tipo?: 'NORMAL' | 'APERTURA') =>
  comoContador((trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha, glosa, lineas, tipo }));
const idPeriodo = async (ejercicio: string, mes: number) =>
  (await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND mes = $2`, [ejercicio, mes])).rows[0].id as string;
const cerrarMesesAbiertos = async (ejercicio: string) => {
  const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND estado = 'ABIERTO' ORDER BY mes`, [ejercicio]);
  for (const p of rows) await comoContador((trx) => cerrarPeriodo(trx, p.id));
};
const nuevoUsuario = async (nombre: string, conMfa: boolean) => {
  const { rows } = await e.owner.query(
    `INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash, totp_activo) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
    [e.clienteA, `${nombre}.${rutAleatorio().toLowerCase()}@prueba.cl`, nombre, conMfa],
  );
  return rows[0].id as string;
};
const designarDirector = (usuarioId: string) =>
  e.owner.query(`INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, 'DIRECTOR')`, [usuarioId, e.empresaA1]);

beforeAll(async () => {
  e = await crearEscenario();
  const q = (texto: string, v: unknown[] = []) => e.owner.query(texto, v);
  await q(
    `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable, requiere_tercero, requiere_centro_costo) VALUES
       ($1, '2',   'Pasivo',          'PASIVO',     'ACREEDORA', false, false, false),
       ($1, '2.1', 'Proveedores',     'PASIVO',     'ACREEDORA', true,  true,  false),
       ($1, '3',   'Patrimonio',      'PATRIMONIO', 'ACREEDORA', false, false, false),
       ($1, '3.1', 'Capital pagado',  'PATRIMONIO', 'ACREEDORA', true,  false, false),
       ($1, '4',   'Ingresos',        'INGRESO',    'ACREEDORA', false, false, false),
       ($1, '4.1', 'Ventas',          'INGRESO',    'ACREEDORA', true,  false, false),
       ($1, '5',   'Gastos',          'GASTO',      'DEUDORA',   false, false, false),
       ($1, '5.1', 'Remuneraciones',  'GASTO',      'DEUDORA',   true,  false, true),
       ($1, '5.2', 'Arriendos',       'GASTO',      'DEUDORA',   true,  false, false),
       ($1, '7.1', 'Boletas de garantía recibidas',  'ORDEN', 'DEUDORA',   true, false, false),
       ($1, '7.2', 'Responsabilidad por garantías',  'ORDEN', 'ACREEDORA', true, false, false)`,
    [e.empresaA1],
  );
  rutProveedor = rutAleatorio();
  await q(`INSERT INTO terceros (empresa_id, rut, razon_social, es_proveedor) VALUES ($1, $2, 'Inmobiliaria Sur SpA', true)`, [
    e.empresaA1,
    rutProveedor,
  ]);
  await q(`INSERT INTO centros_costo (empresa_id, codigo, nombre) VALUES ($1, 'ADM', 'Administración')`, [e.empresaA1]);
  await q(
    `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable) VALUES ($1, '3.2', 'Resultado del ejercicio', 'PATRIMONIO', 'ACREEDORA', true)`,
    [e.empresaA1],
  );
  await q(
    `INSERT INTO configuracion_contable (empresa_id, cuenta_resultado_ejercicio_id, actualizado_por)
     SELECT $1, id, $2 FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '3.2'`,
    [e.empresaA1, e.usuarios.contadorA1.id],
  );
  // Directores designados ANTES de cualquier solicitud; uno sin doble factor.
  for (let i = 0; i < 3; i++) {
    const id = await nuevoUsuario(`director${i}`, true);
    directores.push(id);
    await designarDirector(id);
  }
  directorSinMfa = await nuevoUsuario('director-sin-mfa', false);
  await designarDirector(directorSinMfa);
});
afterAll(async () => {
  await e.cerrar();
});

describe('Ejercicio y registro de asientos', () => {
  it('crear el ejercicio genera sus 12 meses abiertos', async () => {
    ej2025 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2025));
    const ej = (await comoContador((trx) => listarEjercicios(trx, e.empresaA1))).find((x) => x.anio === 2025)!;
    expect(ej.periodos).toHaveLength(12);
    expect(ej.periodos.every((p) => p.estado === 'ABIERTO')).toBe(true);
  });

  it('registra asientos cuadrados con numeración correlativa', async () => {
    const numeros = [
      await asiento('2025-01-02', 'Aporte de capital', [
        { cuenta: '1.1.01', debe: 10_000_000 },
        { cuenta: '3.1', haber: 10_000_000 },
      ]),
      await asiento('2025-01-15', 'Venta de servicios', [
        { cuenta: '1.1.02', debe: '1000000.00' },
        { cuenta: '4.1', haber: 1_000_000 },
      ]),
      await asiento('2025-01-31', 'Sueldos de enero', [
        { cuenta: '5.1', debe: 500_000, centroCosto: 'adm' },
        { cuenta: '1.1.02', haber: 500_000 },
      ]),
      await asiento('2025-01-31', 'Arriendo de oficina', [
        { cuenta: '5.2', debe: 300_000 },
        { cuenta: '2.1', haber: 300_000, tercero: rutProveedor },
      ]),
      await asiento('2025-01-20', 'Boleta de garantía recibida de contratista', [
        { cuenta: '7.1', debe: 1_000 },
        { cuenta: '7.2', haber: 1_000 },
      ]),
    ].map((r) => r.numero);
    expect(numeros).toEqual([1, 2, 3, 4, 5]);
  });

  it.each<[string, LineaAsiento[], RegExp]>([
    ['descuadrado', [{ cuenta: '1.1.01', debe: 100 }, { cuenta: '4.1', haber: 99 }], /descuadrado/u],
    ['una sola línea', [{ cuenta: '1.1.01', debe: 100 }], /al menos dos líneas/u],
    ['cuenta de agrupación', [{ cuenta: '1.1', debe: 100 }, { cuenta: '4.1', haber: 100 }], /no es imputable/u],
    ['cuenta inexistente', [{ cuenta: '9.9', debe: 100 }, { cuenta: '4.1', haber: 100 }], /no existe/u],
    ['falta el tercero', [{ cuenta: '5.2', debe: 100 }, { cuenta: '2.1', haber: 100 }], /exige indicar un tercero/u],
    ['falta el centro de costo', [{ cuenta: '5.1', debe: 100 }, { cuenta: '1.1.01', haber: 100 }], /exige un centro de costo/u],
    ['tres decimales', [{ cuenta: '1.1.01', debe: '100.001' }, { cuenta: '4.1', haber: '100.001' }], /2 decimales/u],
    ['debe y haber en la misma línea', [{ cuenta: '1.1.01', debe: 100, haber: 100 }, { cuenta: '4.1', haber: 0 }], /no en ambos/u],
    ['montos NaN', [{ cuenta: '1.1.01', debe: 'NaN' }, { cuenta: '4.1', haber: 'NaN' }], /monto inválido/u],
  ])('rechaza un asiento con %s', async (_caso, lineas, mensaje) => {
    await expect(asiento('2025-01-20', 'Inválido', lineas)).rejects.toThrow(mensaje);
  });

  it('un asiento rechazado no consume número (sin saltos en el correlativo)', async () => {
    const r = await asiento('2025-01-20', 'Ajuste menor', [
      { cuenta: '1.1.01', debe: 1 },
      { cuenta: '4.1', haber: 1 },
    ]);
    expect(r.numero).toBe(6);
  });

  it('registros simultáneos reciben números únicos y consecutivos', async () => {
    const numeros = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        asiento('2025-02-10', `Venta simultánea ${i}`, [
          { cuenta: '1.1.02', debe: 10 },
          { cuenta: '4.1', haber: 10 },
        ]).then((r) => r.numero),
      ),
    );
    expect([...numeros].sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('el asiento de apertura va el primer día del ejercicio y hay uno solo vigente', async () => {
    // Ejercicio aparte, para no interferir con el cierre anual de 2025 más abajo.
    await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2030));
    const lineas = [
      { cuenta: '1.1.01', debe: 1 },
      { cuenta: '3.1', haber: 1 },
    ];
    await expect(asiento('2030-05-10', 'Apertura tardía', lineas, 'APERTURA')).rejects.toThrow(/debe tener fecha 2030-01-01/u);
    await asiento('2030-01-01', 'Apertura', lineas, 'APERTURA');
    await expect(asiento('2030-01-01', 'Otra apertura', lineas, 'APERTURA')).rejects.toThrow(/ya tiene un asiento de apertura/u);
  });

  it('rechaza fechas fuera de un ejercicio', async () => {
    await expect(
      asiento('2024-12-31', 'Fuera de ejercicio', [
        { cuenta: '1.1.01', debe: 1 },
        { cuenta: '4.1', haber: 1 },
      ]),
    ).rejects.toThrow(/No existe un período/u);
  });

  it('quien no tiene el permiso no registra, ni puede registrar en otra empresa', async () => {
    const lineas = [
      { cuenta: '1.1.01', debe: 1 },
      { cuenta: '4.1', haber: 1 },
    ];
    await expect(
      como(e.usuarios.gerenteA1.id, (trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha: '2025-01-20', glosa: 'x', lineas })),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      como(e.usuarios.contadorA1.id, (trx) => registrarAsiento(trx, { empresaId: e.empresaB1, fecha: '2025-01-20', glosa: 'x', lineas }), e.empresaB1),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('no se puede marcar un asiento como de agente sin una propuesta válida', async () => {
    const lineas = [
      { cuenta: '1.1.01', debe: 1 },
      { cuenta: '4.1', haber: 1 },
    ];
    await expect(
      comoContador((trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha: '2025-01-20', glosa: 'x', lineas, origen: 'AGENTE' })),
    ).rejects.toThrow(/propuesta/u);
    await expect(
      comoContador((trx) =>
        registrarAsiento(trx, {
          empresaId: e.empresaA1,
          fecha: '2025-01-20',
          glosa: 'x',
          lineas,
          origen: 'AGENTE',
          propuestaId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).rejects.toThrow(/no es válida/u);
  });

  it('la aplicación no escribe asientos sin la función, nadie los modifica, y el rol de autenticación no los toca', async () => {
    await expect(
      comoContador((trx) =>
        sql`INSERT INTO asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe) SELECT id, empresa_id, 99, (SELECT id FROM plan_cuentas LIMIT 1), 1 FROM asientos LIMIT 1`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(e.owner.query(`UPDATE asientos SET glosa = 'cambiada' WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query(`DELETE FROM asiento_lineas WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
    await expect(
      enContexto(e.dbAuth, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
        sql`SELECT contabilidad_cerrar_ejercicio(${ej2025}::uuid)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Libro mayor y balance de 8 columnas', () => {
  it('el balance cuadra, muestra la utilidad y deja las cuentas de orden aparte', async () => {
    const b = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2025-01-31'));
    expect(b.cuadrado).toBe(true);
    expect(b.desde).toBe('2025-01-01');
    // 10.000.000 + 1.000.000 + 500.000 + 300.000 + 1 (las cuentas de orden van aparte)
    expect(b.sumas.debitos).toBe('11800001.00');
    expect(b.sumas.debitos).toBe(b.sumas.creditos);
    expect(b.resultadoEjercicio).toBe('200001.00'); // ventas 1.000.001 − sueldos 500.000 − arriendo 300.000
    expect(b.totales.activo).toBe(b.totales.pasivo);
    expect(b.totales.perdida).toBe(b.totales.ganancia);
    expect(b.cuentasDeOrden.map((c) => c.codigo)).toEqual(['7.1', '7.2']);
    expect(b.filas.some((f) => f.codigo.startsWith('7.'))).toBe(false);
  });

  it('el balance acumula desde el inicio del ejercicio', async () => {
    const feb = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2025-02-28'));
    expect(feb.filas.find((f) => f.codigo === '1.1.02')!.saldoDeudor).toBe('500060.00');
  });

  it('el mayor del banco arrastra el saldo del ejercicio', async () => {
    const ene = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1.02', '2025-01-01', '2025-01-31'));
    expect(ene.saldoInicial).toBe('0.00');
    expect(ene.movimientos.map((x) => x.saldo)).toEqual(['1000000.00', '500000.00']);
    const feb = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1.02', '2025-02-01', '2025-02-28'));
    expect(feb.saldoInicial).toBe('500000.00');
    expect(feb.saldoFinal).toBe('500060.00');
  });

  it('el mayor de una cuenta de agrupación suma sus subcuentas', async () => {
    const m = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1', '2025-01-01', '2025-01-31'));
    // Caja 10.000.000 + 1 (ajuste) y Banco 1.000.000 − 500.000
    expect(m.saldoFinal).toBe('10500001.00');
    expect(new Set(m.movimientos.map((x) => x.cuenta))).toEqual(new Set(['1.1.01', '1.1.02']));
  });

  it('el mayor no cruza ejercicios', async () => {
    await expect(comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1.02', '2025-12-01', '2026-01-31'))).rejects.toThrow(
      /dentro de un ejercicio|No existe un ejercicio/u,
    );
  });

  it('quien no tiene permiso de ver asientos no obtiene el balance', async () => {
    await expect(como(e.usuarios.colaboradorA1.id, (trx) => balanceOchoColumnas(trx, e.empresaA1, '2025-12-31'))).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('Reversas', () => {
  let arriendo: string;
  beforeAll(async () => {
    const { rows } = await e.owner.query(`SELECT id FROM asientos WHERE ejercicio_id = $1 AND numero = 4`, [ej2025]);
    arriendo = rows[0].id;
  });

  it('una reversa no puede tener fecha anterior al original', async () => {
    await expect(comoContador((trx) => reversarAsiento(trx, arriendo, '2025-01-30', 'Arriendo duplicado por error'))).rejects.toThrow(
      /anterior al asiento original/u,
    );
  });

  it('se puede reversar aunque la cuenta se haya desactivado después', async () => {
    await e.owner.query(`UPDATE plan_cuentas SET activa = false WHERE empresa_id = $1 AND codigo = '5.2'`, [e.empresaA1]);
    const r = await comoContador((trx) => reversarAsiento(trx, arriendo, '2025-01-31', 'Arriendo duplicado por error'));
    await e.owner.query(`UPDATE plan_cuentas SET activa = true WHERE empresa_id = $1 AND codigo = '5.2'`, [e.empresaA1]);
    const original = await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, arriendo));
    expect(original.reversado_por?.numero).toBe(r.numero);
    const reversa = await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, r.id));
    expect(reversa.tipo).toBe('REVERSA');
    expect(reversa.lineas.map((l) => [l.cuenta, l.debe, l.haber])).toEqual([
      ['5.2', '0.00', '300000.00'],
      ['2.1', '300000.00', '0.00'],
    ]);
    const b = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2025-01-31'));
    expect(b.resultadoEjercicio).toBe('500001.00');
  });

  it('no se reversa dos veces ni se reversa una reversa', async () => {
    await expect(comoContador((trx) => reversarAsiento(trx, arriendo, '2025-01-31', 'Otra vez por error'))).rejects.toThrow(/ya fue reversado/u);
    const { rows } = await e.owner.query(`SELECT id FROM asientos WHERE reversa_de = $1`, [arriendo]);
    await expect(comoContador((trx) => reversarAsiento(trx, rows[0].id, '2025-01-31', 'Reversar la reversa'))).rejects.toThrow(/no se reversa/u);
  });
});

describe('Cierre y reapertura de meses', () => {
  const lineas: LineaAsiento[] = [
    { cuenta: '1.1.01', debe: 5 },
    { cuenta: '4.1', haber: 5 },
  ];

  it('los meses se cierran en orden, y no antes de terminar', async () => {
    await expect(comoContador(async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2025, 3)))).rejects.toThrow(/meses anteriores/u);
    const ej2026 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2026));
    await expect(comoContador(async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2026, 12)))).rejects.toThrow(/aún no termina/u);
    await comoContador(async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2025, 1)));
  });

  it('un mes cerrado no admite asientos', async () => {
    await expect(asiento('2025-01-25', 'Tarde', lineas)).rejects.toThrow(/está cerrado/u);
  });

  it('reabrir un mes exige motivo y queda en la bitácora', async () => {
    const enero = await idPeriodo(ej2025, 1);
    await expect(comoContador((trx) => reabrirPeriodo(trx, enero, 'corto'))).rejects.toThrow(/motivo/u);
    await comoContador((trx) => reabrirPeriodo(trx, enero, 'Factura de proveedor recibida tarde'));
    await asiento('2025-01-25', 'Factura recibida tarde', lineas);
    const { rows } = await e.owner.query(
      `SELECT datos FROM bitacora WHERE empresa_id = $1 AND accion = 'periodo.reabierto' ORDER BY id DESC LIMIT 1`,
      [e.empresaA1],
    );
    expect(rows[0].datos.motivo).toBe('Factura de proveedor recibida tarde');
    await comoContador((trx) => cerrarPeriodo(trx, enero));
  });

  it('reabrir un mes reabre también los meses posteriores ya cerrados', async () => {
    await comoContador(async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2025, 2)));
    await comoContador(async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2025, 3)));
    await comoContador(async (trx) => reabrirPeriodo(trx, await idPeriodo(ej2025, 2), 'Corrección de ventas de febrero'));
    const { rows } = await e.owner.query(`SELECT mes, estado FROM periodos_contables WHERE ejercicio_id = $1 AND mes <= 3 ORDER BY mes`, [ej2025]);
    expect(rows.map((r) => r.estado)).toEqual(['CERRADO', 'ABIERTO', 'ABIERTO']);
    const { rows: ev } = await e.owner.query(
      `SELECT datos FROM bitacora WHERE empresa_id = $1 AND accion = 'periodo.reabierto' ORDER BY id DESC LIMIT 1`,
      [e.empresaA1],
    );
    expect(ev[0].datos.meses_reabiertos.map((m: { mes: number }) => m.mes)).toEqual([2, 3]);
  });

  it('el gerente general no puede cerrar ni reabrir meses', async () => {
    await expect(como(e.usuarios.gerenteA1.id, async (trx) => cerrarPeriodo(trx, await idPeriodo(ej2025, 2)))).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('Cierre del ejercicio y reapertura autorizada por el Directorio', () => {
  const lineas: LineaAsiento[] = [
    { cuenta: '1.1.01', debe: 7 },
    { cuenta: '4.1', haber: 7 },
  ];
  let ej2024: string;
  let solicitud: string;

  it('no se cierra un ejercicio con meses abiertos ni antes que el anterior', async () => {
    await expect(comoContador((trx) => cerrarEjercicio(trx, ej2025))).rejects.toThrow(/deben estar cerrados/u);
    ej2024 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2024));
    await cerrarMesesAbiertos(ej2025);
    await expect(comoContador((trx) => cerrarEjercicio(trx, ej2025))).rejects.toThrow(/ejercicio anterior/u);
    await cerrarMesesAbiertos(ej2024);
    await comoContador((trx) => cerrarEjercicio(trx, ej2024));
    await comoContador((trx) => cerrarEjercicio(trx, ej2025));
  });

  it('con el ejercicio cerrado nada se registra y los meses no se reabren sin el Directorio', async () => {
    await expect(asiento('2025-03-10', 'Tras el cierre', lineas)).rejects.toThrow(/ejercicio 2025 está cerrado/u);
    await expect(comoContador(async (trx) => reabrirPeriodo(trx, await idPeriodo(ej2025, 3), 'Necesito corregir algo'))).rejects.toThrow(
      /Directorio/u,
    );
  });

  it('la solicitud exige motivo y acta; el contador no puede autorizarla', async () => {
    await expect(comoContador((trx) => solicitarReaperturaEjercicio(trx, ej2025, 'corto', 'Acta 12', 15))).rejects.toMatchObject({
      code: '23514',
    });
    solicitud = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2025, 'Observación del auditor externo sobre provisiones', 'Acta de Directorio N° 12', 15),
    );
    await expect(comoContador((trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('un director sin doble factor, o designado después de la solicitud, no puede autorizar', async () => {
    await expect(como(directorSinMfa, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toThrow(
      /doble factor/u,
    );
    const recien = await nuevoUsuario('director-recien-designado', true);
    await designarDirector(recien);
    await expect(como(recien, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toThrow(
      /antes de la solicitud/u,
    );
  });

  it('una sola aprobación no basta y un director no vota dos veces', async () => {
    expect(await como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', 'De acuerdo'))).toBe('PENDIENTE');
    await expect(como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toMatchObject({
      code: '23505',
    });
    await expect(asiento('2025-03-10', 'Aún cerrado', lineas)).rejects.toThrow(/cerrado/u);
  });

  it('con la segunda aprobación el ejercicio se reabre por el plazo indicado', async () => {
    expect(await como(directores[1]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).toBe('APROBADA');
    await comoContador(async (trx) => reabrirPeriodo(trx, await idPeriodo(ej2025, 3), 'Ajuste de provisiones según acta 12'));
    expect((await asiento('2025-03-10', 'Ajuste de provisiones', lineas)).numero).toBeGreaterThan(0);
    const { rows } = await e.owner.query(`SELECT datos FROM bitacora WHERE empresa_id = $1 AND accion = 'ejercicio.reabierto'`, [
      e.empresaA1,
    ]);
    expect(rows[0].datos.acta).toBe('Acta de Directorio N° 12');
  });

  it('si vence el plazo de reapertura, los meses y el ejercicio se pueden volver a cerrar', async () => {
    await e.owner.query(`UPDATE ejercicios_contables SET reabierto_hasta = '2025-01-01' WHERE id = $1`, [ej2025]);
    await expect(asiento('2025-03-11', 'Fuera de plazo', lineas)).rejects.toThrow(/cerrado/u);
    await cerrarMesesAbiertos(ej2025);
    await comoContador((trx) => cerrarEjercicio(trx, ej2025));
  });

  it('una solicitud vencida no bloquea una nueva y su vencimiento queda registrado', async () => {
    const vieja = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2025, 'Segunda observación del auditor externo', 'Acta de Directorio N° 13', 5),
    );
    await e.owner.query(`UPDATE solicitudes_reapertura_ejercicio SET vence_en = now() - interval '1 day' WHERE id = $1`, [vieja]);
    const nueva = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2025, 'Tercera observación del auditor externo', 'Acta de Directorio N° 14', 5),
    );
    expect(nueva).not.toBe(vieja);
    const { rows } = await e.owner.query(`SELECT 1 FROM bitacora WHERE accion = 'ejercicio.reapertura_vencida' AND entidad_id = $1`, [vieja]);
    expect(rows).toHaveLength(1);
    expect(await como(directores[2]!, (trx) => resolverReaperturaEjercicio(trx, nueva, 'RECHAZAR', 'No corresponde'))).toBe('RECHAZADA');
  });

  it('el cargo de Director no se asigna a nivel de Cliente ERP, y nadie se asigna roles a sí mismo', async () => {
    await expect(
      e.owner.query(`INSERT INTO membresias_cliente_erp (usuario_id, cliente_erp_id, rol_codigo) VALUES ($1, $2, 'DIRECTOR')`, [
        directores[0],
        e.clienteA,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      como(e.usuarios.adminA.id, (trx) =>
        trx.insertInto('membresias_empresa').values({ usuario_id: e.usuarios.adminA.id, empresa_id: e.empresaA1, rol_codigo: 'CONTADOR' }).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Asientos propuestos por el agente contable', () => {
  const registro = new RegistroAgentes();
  let ejercicio2027: string;

  beforeAll(async () => {
    ejercicio2027 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2027));
  });

  it('el agente propone, la persona aprueba, y el asiento queda con origen AGENTE', async () => {
    const r = await ejecutarHerramienta(e.db, registro, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      nombre: 'proponer_asiento',
      entrada: {
        fecha: '2027-01-05',
        glosa: 'Venta contado según boleta 1',
        lineas: [
          { cuenta: '1.1.01', debe: 119000 },
          { cuenta: '4.1', haber: 119000 },
        ],
      },
      fecha: '2027-01-05',
    });
    expect(r.estado).toBe('PROPUESTA_CREADA');
    if (r.estado !== 'PROPUESTA_CREADA') return;
    expect(r.resumen).toContain(formatoPesos(aCentavos(119000)));
    const { rows: antes } = await e.owner.query(`SELECT count(*)::int AS n FROM asientos WHERE ejercicio_id = $1`, [ejercicio2027]);
    expect(antes[0].n).toBe(0);

    const res = await resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, r.propuestaId, 'APROBAR');
    expect(res.estado).toBe('EJECUTADA');
    const { rows } = await e.owner.query(`SELECT origen, propuesta_id, total FROM asientos WHERE ejercicio_id = $1`, [ejercicio2027]);
    expect(rows[0]).toMatchObject({ origen: 'AGENTE', propuesta_id: r.propuestaId, total: deCentavos(11900000n) });
  });

  it('un asiento descuadrado propuesto por el modelo se rechaza antes de llegar a una persona', async () => {
    const r = await ejecutarHerramienta(e.db, registro, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      nombre: 'proponer_asiento',
      entrada: {
        fecha: '2027-01-05',
        glosa: 'Descuadrado',
        lineas: [
          { cuenta: '1.1.01', debe: 100 },
          { cuenta: '4.1', haber: 90 },
        ],
      },
      fecha: '2027-01-05',
    });
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'ENTRADA_INVALIDA' });
  });
});
