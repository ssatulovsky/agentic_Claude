import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aFechaChile,
  FuenteCmf,
  FuenteMindicador,
  sincronizarIndicadores,
  type Descargador,
  type FuenteIndicadores,
  type TipoSincronizable,
  type ValorIndicador,
} from '../src/normativa/indicadores.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => {
  await e.cerrar();
});

/** Descargador simulado: responde según la URL. */
const simulado =
  (respuestas: Record<string, unknown>, estado = 200): Descargador =>
  async (url) => {
    const clave = Object.keys(respuestas).find((k) => url.includes(k));
    return { ok: estado === 200 && clave !== undefined, status: clave ? estado : 404, json: async () => (clave ? respuestas[clave] : {}) };
  };

/** Fuente fija para pruebas de conciliación. */
class FuenteFija implements FuenteIndicadores {
  constructor(
    readonly nombre: string,
    private readonly valores: ValorIndicador[],
  ) {}
  url(tipo: TipoSincronizable, anio: number) {
    return `https://fuente.prueba/${tipo}/${anio}`;
  }
  async obtener(tipo: TipoSincronizable) {
    return this.valores.filter((v) => v.tipo === tipo);
  }
}

const valor = async (tipo: string, fecha: string) =>
  (await e.owner.query(`SELECT valor::text, fuente FROM indicadores_economicos WHERE tipo = $1 AND fecha = $2`, [tipo, fecha])).rows[0];

describe('Lectura de fuentes', () => {
  it('convierte la medianoche de Chile expresada en UTC a la fecha chilena (con y sin horario de verano)', () => {
    expect(aFechaChile('2026-09-01T04:00:00.000Z')).toBe('2026-09-01');
    expect(aFechaChile('2026-11-01T03:00:00.000Z')).toBe('2026-11-01');
  });

  it('lee el formato de mindicador.cl', async () => {
    const fuente = new FuenteMindicador(
      simulado({ '/api/utm/2026': { serie: [{ fecha: '2026-11-01T03:00:00.000Z', valor: 72440 }] } }),
    );
    expect(await fuente.obtener('UTM', 2026)).toEqual([{ tipo: 'UTM', fecha: '2026-11-01', valor: '72440.00' }]);
  });

  it('lee el formato de la CMF (miles con punto y decimales con coma)', async () => {
    const fuente = new FuenteCmf('clave', simulado({ '/uf/2026': { UFs: [{ Valor: '41.247,63', Fecha: '2026-10-31' }] } }));
    expect(await fuente.obtener('UF', 2026)).toEqual([{ tipo: 'UF', fecha: '2026-10-31', valor: '41247.63' }]);
  });
});

describe('Sincronización', () => {
  it('guarda los valores nuevos, no duplica los existentes y calcula la UTA', async () => {
    const fuente = new FuenteMindicador(
      simulado({
        '/api/utm/2026': {
          serie: [
            { fecha: '2026-11-01T03:00:00.000Z', valor: 72440 },
            { fecha: '2026-10-01T03:00:00.000Z', valor: 72151 },
            { fecha: '2026-09-01T04:00:00.000Z', valor: 71721 },
          ],
        },
        '/api/uf/2026': { serie: [{ fecha: '2026-10-31T03:00:00.000Z', valor: 41247.63 }] },
      }),
    );
    const cliente = await e.owner.connect();
    try {
      const r = await sincronizarIndicadores(cliente, [fuente], [2026]);
      expect(r.discrepancias).toEqual([]);
      expect(r.conflictos).toEqual([]);
      expect(r.yaExistentes).toBe(2); // UTM de octubre y UF del 31 de octubre ya estaban
    } finally {
      cliente.release();
    }
    expect(await valor('UTM', '2026-11-01')).toMatchObject({ valor: '72440.00' });
    expect(await valor('UTA', '2026-11-01')).toMatchObject({ valor: '869280.00' });
    expect(await valor('UTM', '2026-09-01')).toMatchObject({ valor: '71721.00' });
  });

  it('con dos fuentes, guarda lo que coincide y no guarda lo que difiere', async () => {
    const a = new FuenteFija('Fuente A', [
      { tipo: 'UF', fecha: '2026-11-02', valor: '41255.00' },
      { tipo: 'UF', fecha: '2026-11-03', valor: '41260.00' },
    ]);
    const b = new FuenteFija('Fuente B', [
      { tipo: 'UF', fecha: '2026-11-02', valor: '41255.00' },
      { tipo: 'UF', fecha: '2026-11-03', valor: '41261.00' },
    ]);
    const cliente = await e.owner.connect();
    try {
      const r = await sincronizarIndicadores(cliente, [a, b], [2026], ['UF']);
      expect(r.discrepancias).toEqual([{ tipo: 'UF', fecha: '2026-11-03', valores: { 'Fuente A': '41260.00', 'Fuente B': '41261.00' } }]);
    } finally {
      cliente.release();
    }
    expect(await valor('UF', '2026-11-02')).toMatchObject({ valor: '41255.00', fuente: 'Fuente A + Fuente B' });
    expect(await valor('UF', '2026-11-03')).toBeUndefined();
  });

  it('nunca sobrescribe un valor guardado: lo informa como conflicto', async () => {
    const cliente = await e.owner.connect();
    try {
      const r = await sincronizarIndicadores(cliente, [new FuenteFija('Fuente C', [{ tipo: 'UF', fecha: '2026-10-31', valor: '41000.00' }])], [2026], ['UF']);
      expect(r.conflictos).toEqual([{ tipo: 'UF', fecha: '2026-10-31', guardado: '41247.63', publicado: '41000.00' }]);
    } finally {
      cliente.release();
    }
    expect(await valor('UF', '2026-10-31')).toMatchObject({ valor: '41247.63' });
  });

  it('rechaza una variación inverosímil', async () => {
    const cliente = await e.owner.connect();
    try {
      const r = await sincronizarIndicadores(cliente, [new FuenteFija('Fuente D', [{ tipo: 'UF', fecha: '2026-11-04', valor: '45000.00' }])], [2026], ['UF']);
      expect(r.rechazados).toHaveLength(1);
      expect(r.rechazados[0]!.motivo).toMatch(/variación/u);
    } finally {
      cliente.release();
    }
    expect(await valor('UF', '2026-11-04')).toBeUndefined();
  });

  it('si una fuente falla, informa el error y sigue con las demás; todo queda en la bitácora', async () => {
    const caida = new FuenteMindicador(simulado({}, 500));
    const sana = new FuenteFija('Fuente E', [{ tipo: 'UF', fecha: '2026-11-05', valor: '41270.00' }]);
    const cliente = await e.owner.connect();
    try {
      const r = await sincronizarIndicadores(cliente, [caida, sana], [2026], ['UF']);
      expect(r.erroresFuente).toHaveLength(1);
      expect(r.insertados).toBe(1);
    } finally {
      cliente.release();
    }
    const { rows } = await e.owner.query(`SELECT datos FROM bitacora WHERE accion = 'indicadores.sincronizados' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].datos.errores_fuente).toHaveLength(1);
  });
});
