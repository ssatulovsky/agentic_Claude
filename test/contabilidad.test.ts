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

let e: Escenario;
let rutProveedor: string;
let ejercicioId: string;
const directores: string[] = [];
let contadorDirector: string; // contador que además es director (para probar que no se autoaprueba)

const como = <T>(usuarioId: string, fn: (trx: Trx) => Promise<T>, empresaId?: string) =>
  enContexto(e.db, contextoDeUsuario(usuarioId, empresaId ?? e.empresaA1), fn);
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) => como(e.usuarios.contadorA1.id, fn);
const asiento = (fecha: string, glosa: string, lineas: LineaAsiento[]) =>
  comoContador((trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha, glosa, lineas }));

beforeAll(async () => {
  e = await crearEscenario();
  const q = (texto: string, v: unknown[] = []) => e.owner.query(texto, v);
  // Plan de cuentas mínimo adicional para A1.
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
       ($1, '5.2', 'Arriendos',       'GASTO',      'DEUDORA',   true,  false, false)`,
    [e.empresaA1],
  );
  rutProveedor = rutAleatorio();
  await q(`INSERT INTO terceros (empresa_id, rut, razon_social, es_proveedor) VALUES ($1, $2, 'Inmobiliaria Sur SpA', true)`, [
    e.empresaA1,
    rutProveedor,
  ]);
  await q(`INSERT INTO centros_costo (empresa_id, codigo, nombre) VALUES ($1, 'ADM', 'Administración')`, [e.empresaA1]);

  // Tres directores de A1 y un contador que además es director a nivel del Cliente ERP.
  for (let i = 0; i < 3; i++) {
    const { rows } = await q(
      `INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id`,
      [e.clienteA, `director${i}.${rutAleatorio().toLowerCase()}@prueba.cl`, `Director ${i}`],
    );
    directores.push(rows[0].id);
    await q(`INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, 'DIRECTOR')`, [rows[0].id, e.empresaA1]);
  }
  const { rows } = await q(
    `INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash) VALUES ($1, $2, 'Contador y director', 'x') RETURNING id`,
    [e.clienteA, `cd.${rutAleatorio().toLowerCase()}@prueba.cl`],
  );
  contadorDirector = rows[0].id;
  await q(`INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, 'CONTADOR')`, [contadorDirector, e.empresaA1]);
  await q(`INSERT INTO membresias_cliente_erp (usuario_id, cliente_erp_id, rol_codigo) VALUES ($1, $2, 'DIRECTOR')`, [contadorDirector, e.clienteA]);
});
afterAll(async () => {
  await e.cerrar();
});

describe('Ejercicio y registro de asientos', () => {
  it('crear el ejercicio genera sus 12 meses abiertos', async () => {
    ejercicioId = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2026));
    const [ej] = await comoContador((trx) => listarEjercicios(trx, e.empresaA1));
    expect(ej!.periodos).toHaveLength(12);
    expect(ej!.periodos.every((p) => p.estado === 'ABIERTO')).toBe(true);
  });

  it('registra asientos cuadrados con numeración correlativa', async () => {
    const a1 = await asiento('2026-01-02', 'Aporte de capital', [
      { cuenta: '1.1.01', debe: 10_000_000 },
      { cuenta: '3.1', haber: 10_000_000 },
    ]);
    const a2 = await asiento('2026-01-15', 'Venta de servicios', [
      { cuenta: '1.1.02', debe: '1000000.00' },
      { cuenta: '4.1', haber: 1_000_000 },
    ]);
    const a3 = await asiento('2026-01-31', 'Sueldos de enero', [
      { cuenta: '5.1', debe: 500_000, centroCosto: 'adm' },
      { cuenta: '1.1.02', haber: 500_000 },
    ]);
    const a4 = await asiento('2026-01-31', 'Arriendo de oficina', [
      { cuenta: '5.2', debe: 300_000 },
      { cuenta: '2.1', haber: 300_000, tercero: rutProveedor },
    ]);
    expect([a1.numero, a2.numero, a3.numero, a4.numero]).toEqual([1, 2, 3, 4]);
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
  ])('rechaza un asiento con %s', async (_caso, lineas, mensaje) => {
    await expect(asiento('2026-01-20', 'Inválido', lineas)).rejects.toThrow(mensaje);
  });

  it('un asiento rechazado no consume número (sin saltos en el correlativo)', async () => {
    const r = await asiento('2026-01-20', 'Ajuste menor', [
      { cuenta: '1.1.01', debe: 1 },
      { cuenta: '4.1', haber: 1 },
    ]);
    expect(r.numero).toBe(5);
  });

  it('registros simultáneos reciben números únicos y consecutivos', async () => {
    const numeros = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        asiento('2026-02-10', `Venta simultánea ${i}`, [
          { cuenta: '1.1.02', debe: 10 },
          { cuenta: '4.1', haber: 10 },
        ]).then((r) => r.numero),
      ),
    );
    expect([...numeros].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('rechaza fechas fuera de un ejercicio', async () => {
    await expect(
      asiento('2025-12-31', 'Fuera de ejercicio', [
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
      como(e.usuarios.gerenteA1.id, (trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha: '2026-01-20', glosa: 'x', lineas })),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      como(e.usuarios.contadorA1.id, (trx) => registrarAsiento(trx, { empresaId: e.empresaB1, fecha: '2026-01-20', glosa: 'x', lineas }), e.empresaB1),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('la aplicación no puede insertar asientos sin pasar por la función, y nadie puede modificarlos', async () => {
    await expect(comoContador((trx) => sql`INSERT INTO asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe) SELECT id, empresa_id, 99, (SELECT id FROM plan_cuentas LIMIT 1), 1 FROM asientos LIMIT 1`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(e.owner.query(`UPDATE asientos SET glosa = 'cambiada' WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query(`DELETE FROM asiento_lineas WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
  });
});

describe('Libro mayor y balance de 8 columnas', () => {
  it('el balance cuadra y muestra la utilidad del período', async () => {
    const b = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2026-01-01', '2026-01-31'));
    expect(b.cuadrado).toBe(true);
    expect(b.sumas.debitos).toBe('11800001.00');
    expect(b.sumas.debitos).toBe(b.sumas.creditos);
    // Ventas 1.000.001 − sueldos 500.000 − arriendo 300.000
    expect(b.resultadoEjercicio).toBe('200001.00');
    expect(b.totales.activo).toBe(b.totales.pasivo);
    expect(b.totales.perdida).toBe(b.totales.ganancia);
    const ventas = b.filas.find((f) => f.codigo === '4.1')!;
    expect(ventas).toMatchObject({ saldoAcreedor: '1000001.00', ganancia: '1000001.00', pasivo: '0.00' });
  });

  it('el mayor del banco acumula el saldo según la naturaleza de la cuenta', async () => {
    const m = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1.02', '2026-01-01', '2026-01-31'));
    expect(m.saldoInicial).toBe('0.00');
    expect(m.movimientos.map((x) => x.saldo)).toEqual(['1000000.00', '500000.00']);
    // Desde febrero, el saldo inicial arrastra enero.
    const feb = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1.02', '2026-02-01', '2026-02-28'));
    expect(feb.saldoInicial).toBe('500000.00');
    expect(feb.saldoFinal).toBe('500060.00');
  });

  it('quien no tiene permiso de ver asientos obtiene un balance vacío (seguridad por fila)', async () => {
    const b = await como(e.usuarios.colaboradorA1.id, (trx) => balanceOchoColumnas(trx, e.empresaA1, '2026-01-01', '2026-12-31'));
    expect(b.filas).toHaveLength(0);
  });
});

describe('Reversas', () => {
  let arriendo: string;
  it('una reversa anula el asiento y queda vinculada', async () => {
    const { rows } = await e.owner.query(`SELECT id FROM asientos WHERE empresa_id = $1 AND numero = 4 AND ejercicio_id = $2`, [
      e.empresaA1,
      ejercicioId,
    ]);
    arriendo = rows[0].id;
    const r = await comoContador((trx) => reversarAsiento(trx, arriendo, '2026-01-31', 'Arriendo duplicado por error'));
    const original = await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, arriendo));
    expect(original.reversado_por?.numero).toBe(r.numero);
    const reversa = await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, r.id));
    expect(reversa.tipo).toBe('REVERSA');
    expect(reversa.lineas.map((l) => [l.cuenta, l.debe, l.haber])).toEqual([
      ['5.2', '0.00', '300000.00'],
      ['2.1', '300000.00', '0.00'],
    ]);
    const b = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2026-01-01', '2026-01-31'));
    expect(b.resultadoEjercicio).toBe('500001.00');
  });

  it('no se reversa dos veces ni se reversa una reversa', async () => {
    await expect(comoContador((trx) => reversarAsiento(trx, arriendo, '2026-01-31', 'Otra vez por error'))).rejects.toThrow(/ya fue reversado/u);
    const { rows } = await e.owner.query(`SELECT id FROM asientos WHERE reversa_de = $1`, [arriendo]);
    await expect(comoContador((trx) => reversarAsiento(trx, rows[0].id, '2026-01-31', 'Reversar la reversa'))).rejects.toThrow(/no se reversa/u);
  });
});

describe('Cierre y reapertura de meses', () => {
  const periodo = async (mes: number) => {
    const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND mes = $2`, [ejercicioId, mes]);
    return rows[0].id as string;
  };
  const lineas: LineaAsiento[] = [
    { cuenta: '1.1.01', debe: 5 },
    { cuenta: '4.1', haber: 5 },
  ];

  it('los meses se cierran en orden', async () => {
    const marzo = await periodo(3);
    await expect(comoContador((trx) => cerrarPeriodo(trx, marzo))).rejects.toThrow(/meses anteriores/u);
    await comoContador(async (trx) => cerrarPeriodo(trx, await periodo(1)));
  });

  it('un mes cerrado no admite asientos', async () => {
    await expect(asiento('2026-01-25', 'Tarde', lineas)).rejects.toThrow(/está cerrado/u);
  });

  it('reabrir un mes del ejercicio en curso exige motivo y queda en la bitácora', async () => {
    const enero = await periodo(1);
    await expect(comoContador((trx) => reabrirPeriodo(trx, enero, 'corto'))).rejects.toThrow(/motivo/u);
    await comoContador((trx) => reabrirPeriodo(trx, enero, 'Factura de proveedor recibida tarde'));
    await asiento('2026-01-25', 'Factura recibida tarde', lineas);
    const { rows } = await e.owner.query(
      `SELECT datos FROM bitacora WHERE empresa_id = $1 AND accion = 'periodo.reabierto' ORDER BY id DESC LIMIT 1`,
      [e.empresaA1],
    );
    expect(rows[0].datos.motivo).toBe('Factura de proveedor recibida tarde');
    await comoContador((trx) => cerrarPeriodo(trx, enero));
  });

  it('el gerente general no puede cerrar ni reabrir meses', async () => {
    await expect(como(e.usuarios.gerenteA1.id, async (trx) => cerrarPeriodo(trx, await periodo(2)))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Cierre del ejercicio y reapertura autorizada por el Directorio', () => {
  const lineas: LineaAsiento[] = [
    { cuenta: '1.1.01', debe: 7 },
    { cuenta: '4.1', haber: 7 },
  ];
  let solicitud: string;

  it('no se cierra el ejercicio con meses abiertos', async () => {
    await expect(comoContador((trx) => cerrarEjercicio(trx, ejercicioId))).rejects.toThrow(/deben estar cerrados/u);
  });

  it('con todos los meses cerrados, el ejercicio se cierra y nada más se registra', async () => {
    const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND estado = 'ABIERTO' ORDER BY mes`, [
      ejercicioId,
    ]);
    for (const p of rows) await comoContador((trx) => cerrarPeriodo(trx, p.id));
    await comoContador((trx) => cerrarEjercicio(trx, ejercicioId));
    await expect(asiento('2026-03-10', 'Tras el cierre', lineas)).rejects.toThrow(/ejercicio 2026 está cerrado/u);
    const { rows: marzo } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND mes = 3`, [ejercicioId]);
    await expect(comoContador((trx) => reabrirPeriodo(trx, marzo[0].id, 'Necesito corregir algo'))).rejects.toThrow(/Directorio/u);
  });

  it('la solicitud exige motivo y acta; el contador no puede autorizarla', async () => {
    await expect(
      comoContador((trx) => solicitarReaperturaEjercicio(trx, ejercicioId, 'corto', 'Acta 12', 15)),
    ).rejects.toMatchObject({ code: '23514' });
    solicitud = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ejercicioId, 'Observación del auditor externo sobre provisiones', 'Acta de Directorio N° 12', 15),
    );
    await expect(comoContador((trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('una sola aprobación no basta y un director no vota dos veces', async () => {
    expect(await como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', 'De acuerdo'))).toBe('PENDIENTE');
    await expect(como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).rejects.toMatchObject({
      code: '23505',
    });
    await expect(asiento('2026-03-10', 'Aún cerrado', lineas)).rejects.toThrow(/cerrado/u);
  });

  it('con la segunda aprobación el ejercicio se reabre por el plazo indicado', async () => {
    expect(await como(directores[1]!, (trx) => resolverReaperturaEjercicio(trx, solicitud, 'APROBAR', null))).toBe('APROBADA');
    const { rows } = await e.owner.query(`SELECT reabierto_hasta FROM ejercicios_contables WHERE id = $1`, [ejercicioId]);
    expect(rows[0].reabierto_hasta).not.toBeNull();
    // Los meses siguen cerrados: se reabre el mes que corresponde, con motivo.
    const { rows: marzo } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND mes = 3`, [ejercicioId]);
    await comoContador((trx) => reabrirPeriodo(trx, marzo[0].id, 'Ajuste de provisiones según acta 12'));
    const r = await asiento('2026-03-10', 'Ajuste de provisiones', lineas);
    expect(r.numero).toBeGreaterThan(0);
    const { rows: eventos } = await e.owner.query(
      `SELECT datos FROM bitacora WHERE empresa_id = $1 AND accion = 'ejercicio.reabierto'`,
      [e.empresaA1],
    );
    expect(eventos[0].datos.acta).toBe('Acta de Directorio N° 12');
  });

  it('quien solicita una reapertura no puede autorizarla, aunque sea director', async () => {
    const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND estado = 'ABIERTO'`, [ejercicioId]);
    for (const p of rows) await comoContador((trx) => cerrarPeriodo(trx, p.id));
    await comoContador((trx) => cerrarEjercicio(trx, ejercicioId));
    const nueva = await como(contadorDirector, (trx) =>
      solicitarReaperturaEjercicio(trx, ejercicioId, 'Segunda observación del auditor externo', 'Acta de Directorio N° 13', 5),
    );
    await expect(como(contadorDirector, (trx) => resolverReaperturaEjercicio(trx, nueva, 'APROBAR', null))).rejects.toThrow(
      /no puede autorizarla/u,
    );
    expect(await como(directores[2]!, (trx) => resolverReaperturaEjercicio(trx, nueva, 'RECHAZAR', 'No corresponde'))).toBe('RECHAZADA');
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
