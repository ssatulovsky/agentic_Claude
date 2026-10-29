import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextoDeUsuario, enContexto } from '../src/db/conexion.js';
import {
  calcularImpuestoUnicoMensual,
  esquemaTablaImpuestoUnico,
  obtenerIndicador,
  obtenerParametro,
  ParametroNoVigente,
} from '../src/normativa/normativa.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => {
  await e.cerrar();
});

const conContador = <T>(fn: Parameters<typeof enContexto<T>>[2]) =>
  enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), fn);

describe('Parámetros legales con vigencia', () => {
  it('el ingreso mínimo cambia según la fecha consultada', async () => {
    await conContador(async (trx) => {
      expect((await obtenerParametro(trx, 'IMM.GENERAL', '2026-03-15')).valor).toBe('539000');
      expect((await obtenerParametro(trx, 'IMM.GENERAL', '2026-05-01')).valor).toBe('553553');
      expect((await obtenerParametro(trx, 'IMM.GENERAL', '2026-10-29')).valor).toBe('553553');
    });
  });

  it('el tope imponible 2026 es 90 UF y trae su fuente oficial', async () => {
    await conContador(async (trx) => {
      const tope = await obtenerParametro(trx, 'TOPE_IMPONIBLE.AFP_SALUD', '2026-10-01');
      expect(tope.valor).toBe('90');
      expect(tope.unidad).toBe('UF');
      expect(tope.urlFuente).toMatch(/^https:\/\//u);
    });
  });

  it('la cotización del empleador de agosto 2026 suma 3,5%', async () => {
    await conContador(async (trx) => {
      const claves = [
        'EMPLEADOR.CUENTA_INDIVIDUAL',
        'EMPLEADOR.RENTABILIDAD_PROTEGIDA',
        'EMPLEADOR.EXPECTATIVA_VIDA',
        'EMPLEADOR.SIS',
      ];
      const valores = await Promise.all(claves.map((c) => obtenerParametro(trx, c, '2026-10-01')));
      const totalCentesimas = valores.reduce((s, p) => s + Math.round(Number(p.valor) * 100), 0);
      expect(totalCentesimas).toBe(350);
    });
  });

  it('falla en forma explícita si no hay valor vigente (nunca supone uno)', async () => {
    await conContador(async (trx) => {
      await expect(obtenerParametro(trx, 'TOPE_IMPONIBLE.AFP_SALUD', '2025-06-01')).rejects.toBeInstanceOf(
        ParametroNoVigente,
      );
      // La reforma fija el término de la tasa actual: después de esa fecha exige el valor nuevo.
      await expect(obtenerParametro(trx, 'EMPLEADOR.RENTABILIDAD_PROTEGIDA', '2027-08-01')).rejects.toBeInstanceOf(
        ParametroNoVigente,
      );
    });
  });

  it('no permite dos valores aprobados superpuestos de la misma clave', async () => {
    await expect(
      e.owner.query(
        `INSERT INTO parametros_legales (clave, valor, unidad, vigente_desde, fuente, url_fuente, estado, cargado_por, aprobado_por)
         VALUES ('TOPE_IMPONIBLE.AFP_SALUD', 95, 'UF', '2026-06-01', 'x', 'https://x.cl', 'APROBADO', 'prueba', 'prueba')`,
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('la aplicación no puede modificar parámetros legales', async () => {
    await expect(
      conContador((trx) => trx.updateTable('parametros_legales').set({ valor: 1 }).where('clave', '=', 'IMM.GENERAL').execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('UTM se consulta por mes y UF por día', async () => {
    await conContador(async (trx) => {
      expect((await obtenerIndicador(trx, 'UTM', '2026-10-17')).valor).toBe('72151.00');
      expect((await obtenerIndicador(trx, 'UF', '2026-10-31')).valor).toBe('41247.63');
      await expect(obtenerIndicador(trx, 'UF', '2026-10-30')).rejects.toMatchObject({ codigo: 'INDICADOR_NO_DISPONIBLE' });
    });
  });
});

describe('Impuesto único de segunda categoría (contra la tabla en pesos del SII, octubre 2026)', () => {
  it.each([
    [500_000, 0, 1],
    [974_038, 0, 1], // límite exento: $974.038,50
    [1_000_000, 1_038, 2], // 1.000.000 × 0,04 − 38.961,54
    [3_000_000, 114_457, 3], // 3.000.000 × 0,08 − 125.542,74
    [6_000_000, 576_238, 5], // 6.000.000 × 0,23 − 803.762,14
    [10_000_000, 1_817_439, 7], // 10.000.000 × 0,35 − 1.682.561,32
    [25_000_000, 7_199_098, 8], // 25.000.000 × 0,40 − 2.800.901,82
  ])('renta %i → impuesto %i (tramo %i)', async (renta, impuesto, tramo) => {
    await conContador(async (trx) => {
      const r = await calcularImpuestoUnicoMensual(trx, renta, '2026-10-31');
      expect(r.impuestoPesos).toBe(impuesto);
      expect(r.tramo).toBe(tramo);
    });
  });
});

describe('Validación de tablas legales', () => {
  const base = [
    { desde: 0, hasta: 13.5, factor: 0, rebaja: 0 },
    { desde: 13.5, hasta: null, factor: 0.04, rebaja: 0.54 },
  ];
  it('acepta tramos contiguos que parten en 0 y terminan abiertos', () => {
    expect(esquemaTablaImpuestoUnico.safeParse({ unidad: 'UTM', tramos: base }).success).toBe(true);
  });
  it('rechaza una tabla con huecos, con último tramo cerrado o que no parte en 0', () => {
    const conHueco = [base[0], { ...base[1], desde: 14 }];
    const cerrada = [base[0], { ...base[1], hasta: 30 }];
    const sinCero = [{ ...base[0], desde: 1 }, base[1]];
    for (const tramos of [conHueco, cerrada, sinCero]) {
      expect(esquemaTablaImpuestoUnico.safeParse({ unidad: 'UTM', tramos }).success).toBe(false);
    }
  });
});
