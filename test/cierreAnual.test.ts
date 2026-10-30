import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarEjercicio,
  cerrarPeriodo,
  configurarContabilidad,
  crearEjercicio,
  obtenerAsiento,
  reabrirPeriodo,
  registrarAsiento,
  resolverReaperturaEjercicio,
  reversarAsiento,
  solicitarReaperturaEjercicio,
  type LineaAsiento,
} from '../src/contabilidad/libroDiario.js';
import { balanceOchoColumnas } from '../src/contabilidad/reportes.js';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { crearEscenario, rutAleatorio, type Escenario } from './escenario.js';

/*
 * Ejercicio 2023 de prueba:
 *   Aporte de capital         Caja 1.000.000 / Capital 1.000.000
 *   Venta                     Banco 500.000 / Ventas 500.000
 *   Arriendo (con proveedor)  Arriendos 200.000 / Proveedores 200.000
 *   Garantía (cuenta de orden) 7.1 50.000 / 7.2 50.000
 * Utilidad esperada: 300.000.
 */

let e: Escenario;
let rutProveedor: string;
let ej2023: string;
let ej2024: string;
const directores: string[] = [];

const comoContador = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);
const como = <T>(u: string, fn: (trx: Trx) => Promise<T>) => enContexto(e.db, contextoDeUsuario(u, e.empresaA1), fn);
const asiento = (fecha: string, glosa: string, lineas: LineaAsiento[], tipo?: 'NORMAL' | 'APERTURA') =>
  comoContador((trx) => registrarAsiento(trx, { empresaId: e.empresaA1, fecha, glosa, lineas, tipo }));
const cerrarMeses = async (ejercicio: string) => {
  const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND estado = 'ABIERTO' ORDER BY mes`, [ejercicio]);
  for (const p of rows) await comoContador((trx) => cerrarPeriodo(trx, p.id));
};
const vigente = async (ejercicio: string, tipo: string) => {
  const { rows } = await e.owner.query(
    `SELECT a.id FROM asientos a WHERE a.ejercicio_id = $1 AND a.tipo = $2
       AND NOT EXISTS (SELECT 1 FROM asientos r WHERE r.reversa_de = a.id)`,
    [ejercicio, tipo],
  );
  return rows.map((r) => r.id as string);
};
const lineasDe = async (asientoId: string) =>
  (await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, asientoId))).lineas.map((l) => [l.cuenta, l.debe, l.haber, l.tercero]);

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(
    `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable, requiere_tercero) VALUES
       ($1, '2.1', 'Proveedores',             'PASIVO',     'ACREEDORA', true,  true),
       ($1, '3.1', 'Capital pagado',          'PATRIMONIO', 'ACREEDORA', true,  false),
       ($1, '3.2', 'Resultado del ejercicio', 'PATRIMONIO', 'ACREEDORA', true,  false),
       ($1, '4.1', 'Ventas',                  'INGRESO',    'ACREEDORA', true,  false),
       ($1, '5.2', 'Arriendos',               'GASTO',      'DEUDORA',   true,  false),
       ($1, '7.1', 'Garantías recibidas',     'ORDEN',      'DEUDORA',   true,  false),
       ($1, '7.2', 'Responsabilidad garantías','ORDEN',     'ACREEDORA', true,  false)`,
    [e.empresaA1],
  );
  rutProveedor = rutAleatorio();
  await e.owner.query(`INSERT INTO terceros (empresa_id, rut, razon_social, es_proveedor) VALUES ($1, $2, 'Inmobiliaria Sur SpA', true)`, [
    e.empresaA1,
    rutProveedor,
  ]);
  for (let i = 0; i < 2; i++) {
    const { rows } = await e.owner.query(
      `INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash, totp_activo) VALUES ($1, $2, $3, 'x', true) RETURNING id`,
      [e.clienteA, `dir${i}.${rutAleatorio().toLowerCase()}@prueba.cl`, `Director ${i}`],
    );
    directores.push(rows[0].id);
    await e.owner.query(`INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, 'DIRECTOR')`, [rows[0].id, e.empresaA1]);
  }

  ej2023 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2023));
  await asiento('2023-03-01', 'Aporte de capital', [{ cuenta: '1.1.01', debe: 1_000_000 }, { cuenta: '3.1', haber: 1_000_000 }]);
  await asiento('2023-06-15', 'Venta', [{ cuenta: '1.1.02', debe: 500_000 }, { cuenta: '4.1', haber: 500_000 }]);
  await asiento('2023-09-30', 'Arriendo', [{ cuenta: '5.2', debe: 200_000 }, { cuenta: '2.1', haber: 200_000, tercero: rutProveedor }]);
  await asiento('2023-10-01', 'Garantía recibida', [{ cuenta: '7.1', debe: 50_000 }, { cuenta: '7.2', haber: 50_000 }]);
  await cerrarMeses(ej2023);
});
afterAll(async () => {
  await e.cerrar();
});

describe('Configuración previa', () => {
  it('sin la cuenta de resultado configurada no se cierra el ejercicio', async () => {
    await expect(comoContador((trx) => cerrarEjercicio(trx, ej2023))).rejects.toThrow(/Configure una cuenta de resultado/u);
  });

  it('la cuenta de resultado debe ser de patrimonio e imputable', async () => {
    await expect(comoContador((trx) => configurarContabilidad(trx, e.empresaA1, '4.1'))).rejects.toThrow(/patrimonio/u);
    await comoContador((trx) => configurarContabilidad(trx, e.empresaA1, '3.2'));
  });

  it('una apertura manual en el ejercicio siguiente detiene el cierre', async () => {
    ej2024 = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2024));
    const manual = await asiento('2024-01-01', 'Apertura manual', [{ cuenta: '1.1.01', debe: 1 }, { cuenta: '3.1', haber: 1 }], 'APERTURA');
    await expect(comoContador((trx) => cerrarEjercicio(trx, ej2023))).rejects.toThrow(/registrado manualmente/u);
    await comoContador((trx) => reversarAsiento(trx, (manual as { id: string }).id, '2024-01-01', 'Se usará la apertura automática'));
  });
});

describe('Cierre anual', () => {
  it('genera el asiento de cierre de resultados contra la cuenta de resultado del ejercicio', async () => {
    await comoContador((trx) => cerrarEjercicio(trx, ej2023));
    const [cierre] = await vigente(ej2023, 'CIERRE');
    expect(await lineasDe(cierre!)).toEqual(
      expect.arrayContaining([
        ['4.1', '500000.00', '0.00', null],
        ['5.2', '0.00', '200000.00', null],
        ['3.2', '0.00', '300000.00', null], // utilidad al haber
      ]),
    );
    const a = await comoContador((trx) => obtenerAsiento(trx, e.empresaA1, cierre!));
    expect(a).toMatchObject({ fecha: '2023-12-31', tipo: 'CIERRE', origen: 'MODULO' });
  });

  it('genera la apertura del ejercicio siguiente con los saldos de balance, de orden y el detalle por tercero', async () => {
    const [apertura] = await vigente(ej2024, 'APERTURA');
    const lineas = await lineasDe(apertura!);
    expect(lineas).toHaveLength(7);
    expect(lineas).toEqual(
      expect.arrayContaining([
        ['1.1.01', '1000000.00', '0.00', null],
        ['1.1.02', '500000.00', '0.00', null],
        ['2.1', '0.00', '200000.00', rutProveedor],
        ['3.1', '0.00', '1000000.00', null],
        ['3.2', '0.00', '300000.00', null],
        ['7.1', '50000.00', '0.00', null],
        ['7.2', '0.00', '50000.00', null],
      ]),
    );
  });

  it('el balance del año cerrado sigue mostrando el resultado; el del año nuevo parte cuadrado y sin resultado', async () => {
    const b2023 = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2023-12-31'));
    expect(b2023.resultadoEjercicio).toBe('300000.00');
    expect(b2023.cuadrado).toBe(true);
    const b2024 = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2024-01-31'));
    expect(b2024.cuadrado).toBe(true);
    expect(b2024.resultadoEjercicio).toBe('0.00');
    expect(b2024.totales.activo).toBe('1500000.00'); // caja 1.000.000 + banco 500.000 (la apertura manual y su reversa se anulan)
    expect(b2024.filas.find((f) => f.codigo === '3.2')!.pasivo).toBe('300000.00');
  });

  it('el asiento de cierre no se reversa a mano', async () => {
    const [cierre] = await vigente(ej2023, 'CIERRE');
    await expect(comoContador((trx) => reversarAsiento(trx, cierre!, '2023-12-31', 'Intento manual de reversa'))).rejects.toThrow(
      /los reversa el sistema/u,
    );
  });
});

describe('Reapertura y nuevo cierre', () => {
  it('al aprobarse la reapertura se reversan solos el cierre y la apertura automática', async () => {
    const sol = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2023, 'Gasto de arriendo de diciembre no contabilizado', 'Acta de Directorio N° 7', 10),
    );
    await como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, sol, 'APROBAR', null));
    expect(await como(directores[1]!, (trx) => resolverReaperturaEjercicio(trx, sol, 'APROBAR', null))).toBe('APROBADA');
    expect(await vigente(ej2023, 'CIERRE')).toHaveLength(0);
    expect(await vigente(ej2024, 'APERTURA')).toHaveLength(0);
  });

  it('al volver a cerrar se regeneran con los saldos corregidos', async () => {
    const { rows } = await e.owner.query(`SELECT id FROM periodos_contables WHERE ejercicio_id = $1 AND mes = 12`, [ej2023]);
    await comoContador((trx) => reabrirPeriodo(trx, rows[0].id, 'Registrar arriendo de diciembre'));
    await asiento('2023-12-31', 'Arriendo de diciembre', [
      { cuenta: '5.2', debe: 50_000 },
      { cuenta: '2.1', haber: 50_000, tercero: rutProveedor },
    ]);
    await cerrarMeses(ej2023);
    await comoContador((trx) => cerrarEjercicio(trx, ej2023));

    const [cierre] = await vigente(ej2023, 'CIERRE');
    expect(await lineasDe(cierre!)).toEqual(expect.arrayContaining([['3.2', '0.00', '250000.00', null]]));
    const aperturas = await vigente(ej2024, 'APERTURA');
    expect(aperturas).toHaveLength(1);
    expect(await lineasDe(aperturas[0]!)).toEqual(
      expect.arrayContaining([
        ['2.1', '0.00', '250000.00', rutProveedor],
        ['3.2', '0.00', '250000.00', null],
      ]),
    );
    const b2023 = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2023-12-31'));
    expect(b2023.resultadoEjercicio).toBe('250000.00');
  });

  it('no se solicita reabrir un ejercicio si uno posterior ya está cerrado', async () => {
    await cerrarMeses(ej2024);
    await comoContador((trx) => cerrarEjercicio(trx, ej2024));
    // El cierre de 2024 crea 2025 y su apertura.
    const { rows } = await e.owner.query(`SELECT id FROM ejercicios_contables WHERE empresa_id = $1 AND anio = 2025`, [e.empresaA1]);
    expect(await vigente(rows[0].id, 'APERTURA')).toHaveLength(1);
    await expect(
      comoContador((trx) => solicitarReaperturaEjercicio(trx, ej2023, 'Otra corrección pendiente del año', 'Acta de Directorio N° 8', 5)),
    ).rejects.toThrow(/posterior cerrado/u);
  });
});

describe('Controles agregados tras la revisión independiente', () => {
  it('ninguna función queda ejecutable por PUBLIC', async () => {
    const { rows } = await e.owner.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proowner = 'erp_owner'::regrole
        AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('la aplicación no puede llamar a las funciones internas del cierre', async () => {
    await expect(
      comoContador((trx) =>
        sql`SELECT contabilidad_crear_ejercicio_interno(${e.empresaA1}::uuid, 2040, '2040-01-01'::date)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('nadie registra un asiento con origen de sistema ni reversa a mano una apertura automática', async () => {
    await expect(
      comoContador((trx) =>
        sql`SELECT contabilidad_registrar_asiento(${e.empresaA1}::uuid, '2025-01-01'::date, 'falsa', '[{"cuenta":"1.1.01","debe":1},{"cuenta":"3.1","haber":1}]'::jsonb, 'APERTURA', NULL, 'MODULO')`.execute(trx),
      ),
    ).rejects.toThrow(/Origen no permitido/u);
    const { rows } = await e.owner.query(`SELECT id FROM ejercicios_contables WHERE empresa_id = $1 AND anio = 2025`, [e.empresaA1]);
    const [apertura] = await vigente(rows[0].id, 'APERTURA');
    await expect(comoContador((trx) => reversarAsiento(trx, apertura!, '2025-01-01', 'Intento manual de reversa'))).rejects.toThrow(
      /los reversa el sistema/u,
    );
  });
});

describe('Orden entre ejercicios ante reaperturas', () => {
  const idEjercicio = async (anio: number) =>
    (await e.owner.query(`SELECT id FROM ejercicios_contables WHERE empresa_id = $1 AND anio = $2`, [e.empresaA1, anio])).rows[0].id as string;
  const aprobar = async (sol: string) => {
    await como(directores[0]!, (trx) => resolverReaperturaEjercicio(trx, sol, 'APROBAR', null));
    return como(directores[1]!, (trx) => resolverReaperturaEjercicio(trx, sol, 'APROBAR', null));
  };

  it('si se cierra un ejercicio posterior mientras la solicitud espera, la reapertura ya no procede', async () => {
    const sol = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2024, 'Revisión de provisiones del año 2024', 'Acta de Directorio N° 9', 5),
    );
    const ej2025 = await idEjercicio(2025);
    await cerrarMeses(ej2025);
    await comoContador((trx) => cerrarEjercicio(trx, ej2025));
    await expect(aprobar(sol)).rejects.toThrow(/ejercicio posterior/u);
  });

  it('un ejercicio reabierto y no vuelto a cerrar impide cerrar el siguiente, aunque su plazo haya vencido', async () => {
    const ej2025 = await idEjercicio(2025);
    const sol = await comoContador((trx) =>
      solicitarReaperturaEjercicio(trx, ej2025, 'Revisión de provisiones del año 2025', 'Acta de Directorio N° 10', 5),
    );
    expect(await aprobar(sol)).toBe('APROBADA');
    await e.owner.query(`UPDATE ejercicios_contables SET reabierto_hasta = '2020-01-01' WHERE id = $1`, [ej2025]);
    await expect(comoContador(async (trx) => cerrarEjercicio(trx, await idEjercicio(2026)))).rejects.toThrow(/ejercicio anterior/u);
  });
});
