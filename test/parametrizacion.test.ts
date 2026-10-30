import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearEjercicio, registrarAsiento } from '../src/contabilidad/libroDiario.js';
import { cargarPlanBase, configurarImputacion, historialImputacion, listarImputaciones } from '../src/contabilidad/parametrizacion.js';
import { contextoDeUsuario, enContexto, type Trx } from '../src/db/conexion.js';
import {
  contabilizarMovimiento,
  crearCuentaBancaria,
  crearRegla,
  importarCartola,
  informeConciliacion,
  listarReglas,
  sugerirConciliacion,
} from '../src/tesoreria/conciliacion.js';
import { crearEscenario, type Escenario } from './escenario.js';

const CARTOLA = readFileSync(new URL('./datos/cartola_scotiabank_sep2026.xls', import.meta.url));
const CLIENTE = '76111222-8';
const SOCIO = '12345678-5';
const PRESTAMISTA = '11222333-9';

let e: Escenario;
const comoContador = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);
const comoAgente = <T>(fn: (trx: Trx) => Promise<T>) =>
  enContexto(e.db, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1, actorTipo: 'AGENTE', actorId: 'TESORERO' }, fn);

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(
    `INSERT INTO suscripciones_modulo (empresa_id, modulo_codigo, pagador, vigente_desde) VALUES ($1, 'TESORERIA', 'EMPRESA', '2026-01-01')`,
    [e.empresaA1],
  );
  for (const [rut, nombre] of [
    [CLIENTE, 'Cliente de Prueba SpA'],
    [SOCIO, 'Socio Uno'],
    [PRESTAMISTA, 'Persona Dos'],
  ]) {
    await e.owner.query(`INSERT INTO terceros (empresa_id, rut, razon_social) VALUES ($1, $2, $3)`, [e.empresaA1, rut, nombre]);
  }
});
afterAll(async () => {
  await e.cerrar();
});

describe('Plan de cuentas base e imputaciones', () => {
  it('carga el plan base sin tocar las cuentas existentes, una sola vez', async () => {
    const r = await comoContador((trx) => cargarPlanBase(trx, e.empresaA1));
    // La empresa ya tenía 1, 1.1, 1.1.01 y 1.1.02.
    expect(r).toEqual({ cuentas_creadas: 50, imputaciones_creadas: 23, conceptos_sin_configurar: [] });
    expect(await comoContador((trx) => cargarPlanBase(trx, e.empresaA1))).toEqual({
      cuentas_creadas: 0,
      imputaciones_creadas: 0,
      conceptos_sin_configurar: [],
    });
    const { rows } = await e.owner.query(`SELECT nombre FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '1.1.02'`, [e.empresaA1]);
    expect(rows[0].nombre).toBe('Banco Estado cuenta corriente');
  });

  it('lista cada concepto con su cuenta y las cuentas que admite', async () => {
    const lista = await comoContador((trx) => listarImputaciones(trx, e.empresaA1));
    const retiros = lista.find((i) => i.concepto === 'RETIROS_SOCIOS')!;
    expect(retiros.cuenta).toEqual({ codigo: '3.1.02', nombre: 'Retiros de socios' });
    expect(retiros.opciones.map((o) => o.codigo)).toContain('2.1.09');
    expect(retiros.opciones.map((o) => o.codigo)).not.toContain('4.1.01');
    expect(lista.find((i) => i.concepto === 'PRESTAMOS_POR_PAGAR')!.cuenta?.codigo).toBe('2.1.08');
  });

  it('cambia la imputación solo a una cuenta de la clasificación permitida, con motivo e historial', async () => {
    await expect(comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'RETIROS_SOCIOS', '4.1.01', 'Prueba'))).rejects.toThrow(
      /PATRIMONIO o ACTIVO o PASIVO/u,
    );
    await expect(comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'RETIROS_SOCIOS', '1', 'Cuenta de grupo'))).rejects.toThrow(
      /imputable/u,
    );
    await expect(comoAgente((trx) => configurarImputacion(trx, e.empresaA1, 'RETIROS_SOCIOS', '2.1.09', 'Intento del agente'))).rejects.toThrow(
      /una persona/u,
    );
    await comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'GASTOS_BANCARIOS', '5.1.05', 'Se agrupan en gastos generales'));
    const h = await comoContador((trx) => historialImputacion(trx, e.empresaA1, 'GASTOS_BANCARIOS'));
    expect(h.map((x) => [x.cuenta, x.estado])).toEqual([
      ['5.1.05', 'VIGENTE'],
      ['5.2.01', 'REEMPLAZADA'],
    ]);
    await comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'GASTOS_BANCARIOS', '5.2.01', 'Vuelve a su cuenta propia'));
    await expect(e.owner.query(`DELETE FROM imputaciones WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifica/u);
  });

  it('las personas sin acceso al plan de cuentas no ven las imputaciones', async () => {
    const lista = await enContexto(e.db, contextoDeUsuario(e.usuarios.adminB.id, e.empresaA1), (trx) =>
      trx.selectFrom('imputaciones' as never).selectAll().execute(),
    );
    expect(lista).toHaveLength(0);
  });
});

describe('Septiembre 2026: retiros del socio y reintegro de un préstamo', () => {
  let cuenta: string;

  it('las reglas por concepto siguen a la imputación vigente', async () => {
    await comoContador((trx) => crearEjercicio(trx, e.empresaA1, 2026));
    cuenta = await comoContador((trx) =>
      crearCuentaBancaria(trx, { empresaId: e.empresaA1, banco: 'SCOTIABANK', numero: '1234567890', cuentaContable: '1.1.02' }),
    );
    await expect(
      comoContador((trx) =>
        crearRegla(trx, { empresaId: e.empresaA1, nombre: 'Retiros', rut: SOCIO, sentido: 'CARGO', destino: 'RETIROS_SOCIOS', glosa: 'Retiro' }),
      ),
    ).rejects.toThrow(/exige un tercero/u);
    await comoContador((trx) =>
      crearRegla(trx, {
        empresaId: e.empresaA1,
        nombre: 'Retiros del socio',
        rut: SOCIO,
        sentido: 'CARGO',
        destino: 'RETIROS_SOCIOS',
        tercero: SOCIO,
        glosa: 'Retiro del socio',
      }),
    );
    await comoContador((trx) =>
      crearRegla(trx, {
        empresaId: e.empresaA1,
        nombre: 'Reintegro de préstamo',
        rut: PRESTAMISTA,
        sentido: 'CARGO',
        destino: 'PRESTAMOS_POR_PAGAR',
        tercero: PRESTAMISTA,
        glosa: 'Reintegro de préstamo',
      }),
    );
    await comoContador((trx) =>
      crearRegla(trx, {
        empresaId: e.empresaA1,
        nombre: 'Cobros del cliente',
        rut: CLIENTE,
        sentido: 'ABONO',
        destino: 'CLIENTES',
        tercero: CLIENTE,
        glosa: 'Cobro de facturas',
      }),
    );
    const reglas = await comoContador((trx) => listarReglas(trx, e.empresaA1));
    expect(reglas.find((r) => r.concepto === 'RETIROS_SOCIOS')!.cuenta_contable).toBe('3.1.02');
    // Si se cambia la imputación, la regla usa la cuenta nueva.
    await comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'RETIROS_SOCIOS', '2.1.09', 'Prueba de cambio'));
    expect((await comoContador((trx) => listarReglas(trx, e.empresaA1))).find((r) => r.concepto === 'RETIROS_SOCIOS')!.cuenta_contable).toBe(
      '2.1.09',
    );
    await comoContador((trx) => configurarImputacion(trx, e.empresaA1, 'RETIROS_SOCIOS', '3.1.02', 'Retiros a patrimonio, según el contador'));
  });

  it('la cartola real se clasifica completa con las reglas y la conciliación cuadra', async () => {
    await comoContador((trx) =>
      registrarAsiento(trx, {
        empresaId: e.empresaA1,
        fecha: '2026-08-31',
        glosa: 'Saldo del banco al 31-08',
        lineas: [
          { cuenta: '1.1.02', debe: 81_000 },
          { cuenta: '3.1.01', haber: 81_000 },
        ],
      }),
    );
    await comoContador((trx) => importarCartola(trx, { empresaId: e.empresaA1, cuentaId: cuenta, archivoNombre: 'sep.xls', contenido: CARTOLA }));
    const s = await comoContador((trx) => sugerirConciliacion(trx, e.empresaA1, cuenta, '2026-09-30'));
    expect(s.sugerencias.every((x) => x.tipo === 'CONTABILIZAR')).toBe(true);
    const porConcepto = new Map<string, number>();
    for (const x of s.sugerencias) {
      if (x.tipo !== 'CONTABILIZAR') continue;
      porConcepto.set(x.regla.concepto!, (porConcepto.get(x.regla.concepto!) ?? 0) + 1);
      await comoContador((trx) =>
        contabilizarMovimiento(trx, {
          empresaId: e.empresaA1,
          movimientoId: x.movimientoId,
          cuentaContable: x.regla.cuentaContable,
          tercero: x.regla.tercero ?? undefined,
          glosa: x.regla.glosa,
        }),
      );
    }
    expect(Object.fromEntries(porConcepto)).toEqual({ CLIENTES: 1, RETIROS_SOCIOS: 10, PRESTAMOS_POR_PAGAR: 1 });
    const i = await comoContador((trx) => informeConciliacion(trx, e.empresaA1, cuenta, '2026-09-28'));
    expect(i).toMatchObject({ saldoBanco: 790_000, saldoLibros: 790_000, diferencia: 0, cuadra: true });
    expect(i.movimientosNoContabilizados).toHaveLength(0);
    const { rows } = await e.owner.query<{ codigo: string; total: string }>(
      `SELECT p.codigo, sum(l.debe - l.haber)::text AS total FROM asiento_lineas l JOIN plan_cuentas p ON p.id = l.cuenta_id
       WHERE l.empresa_id = $1 AND p.codigo IN ('3.1.02', '2.1.08', '1.1.03') GROUP BY p.codigo ORDER BY p.codigo`,
      [e.empresaA1],
    );
    expect(rows).toEqual([
      { codigo: '1.1.03', total: '-3750000.00' },
      { codigo: '2.1.08', total: '50000.00' },
      { codigo: '3.1.02', total: '2991000.00' },
    ]);
  });
});
