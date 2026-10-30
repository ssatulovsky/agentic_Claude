import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearEjercicio } from '../src/contabilidad/libroDiario.js';
import { balanceOchoColumnas, libroMayor } from '../src/contabilidad/reportes.js';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import { crearEscenario, type Escenario } from './escenario.js';

/*
 * Un año con 3.000 asientos (6.000 líneas), cargados de una vez y sin estadísticas
 * actualizadas (el peor caso, como una base recién cargada). Los reportes deben
 * responder en menos de 3 segundos.
 */
const ASIENTOS = 3000;
let e: Escenario;
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);

beforeAll(async () => {
  e = await crearEscenario();
  const ejercicio = await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2022));
  await e.owner.query(
    `WITH cuentas AS (
       SELECT (SELECT id FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '1.1.01') AS caja,
              (SELECT id FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '1.1.02') AS banco
     ), nuevos AS (
       INSERT INTO asientos (id, empresa_id, ejercicio_id, periodo_id, numero, fecha, tipo, origen, glosa, total, registrado_por)
       SELECT gen_random_uuid(), $1, $2, p.id, g, p.fecha_inicio + (g % 28), 'NORMAL', 'MANUAL', 'Carga de prueba', 100, $3
       FROM generate_series(1, $4::int) g
       JOIN periodos_contables p ON p.ejercicio_id = $2 AND p.mes = 1 + (g % 12)
       RETURNING id
     )
     INSERT INTO asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber)
     SELECT n.id, $1, 1, c.caja, 100, 0 FROM nuevos n, cuentas c
     UNION ALL
     SELECT n.id, $1, 2, c.banco, 0, 100 FROM nuevos n, cuentas c`,
    [e.empresaA1, ejercicio, e.usuarios.contadorA1.id, ASIENTOS],
  );
  await e.owner.query(`UPDATE ejercicios_contables SET ultimo_numero = $2 WHERE id = $1`, [ejercicio, ASIENTOS]);
});
afterAll(async () => {
  await e.cerrar();
});

describe('Rendimiento de reportes', () => {
  it(`balance de 8 columnas con ${ASIENTOS} asientos en menos de 3 segundos`, async () => {
    const inicio = performance.now();
    const b = await comoContador((trx) => balanceOchoColumnas(trx, e.empresaA1, '2022-12-31'));
    const ms = performance.now() - inicio;
    expect(b.sumas.debitos).toBe(`${ASIENTOS * 100}.00`);
    expect(b.cuadrado).toBe(true);
    expect(ms).toBeLessThan(3000);
  });

  it(`libro mayor de una cuenta de agrupación con ${ASIENTOS * 2} líneas en menos de 3 segundos`, async () => {
    const inicio = performance.now();
    const m = await comoContador((trx) => libroMayor(trx, e.empresaA1, '1.1', '2022-07-01', '2022-12-31'));
    const ms = performance.now() - inicio;
    expect(m.saldoFinal).toBe('0.00');
    expect(ms).toBeLessThan(3000);
  });
});
