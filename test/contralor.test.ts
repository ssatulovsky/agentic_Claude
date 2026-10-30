import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { cifrasDelTexto, cifrasSinRespaldo } from '../src/agentes/contralor.js';
import { conversar } from '../src/agentes/conversacion.js';
import { ejecutarHerramienta, resolverPropuesta } from '../src/agentes/ejecutor.js';
import type { ModeloIA, RespuestaModelo } from '../src/agentes/tipos.js';
import { crearEjercicio } from '../src/contabilidad/libroDiario.js';
import { contextoDeUsuario, enContexto } from '../src/db/conexion.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
const registro = new RegistroAgentes();
const HOY = '2026-10-30';

const proponer = (entrada: unknown, usuarioId = e.usuarios.contadorA1.id) =>
  ejecutarHerramienta(e.db, registro, {
    agenteCodigo: 'CONTADOR_GENERAL',
    solicitante: { usuarioId, empresaId: e.empresaA1 },
    nombre: 'proponer_asiento',
    entrada,
    fecha: HOY,
  });
const traspaso = (monto: number, glosa = 'Depósito de caja en la cuenta corriente', fecha = '2026-10-15') => ({
  fecha,
  glosa,
  lineas: [
    { cuenta: '1.1.02', debe: monto },
    { cuenta: '1.1.01', haber: monto },
  ],
});

beforeAll(async () => {
  e = await crearEscenario();
  await enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) => crearEjercicio(trx, e.empresaA1, 2026));
});
afterAll(async () => {
  await e.cerrar();
});

describe('Contralor: control de cifras de las respuestas', () => {
  it('reconoce cifras chilenas e ignora fechas, RUT, códigos de cuenta y años', () => {
    expect(cifrasDelTexto('Saldo $790.000 al 30-09-2026, cuenta 1.1.02, RUT 76.123.456-7, año 2026, tasa 0,25% y 1.234,5 UF').map((c) => c.texto)).toEqual([
      '$790.000',
      '0,25%',
      '1.234,5',
    ]);
    expect(cifrasDelTexto('Hay 3 movimientos en 2 cuentas')).toEqual([]);
  });

  it('una cifra respaldada por los datos pasa; una inventada o calculada se marca', () => {
    const datos = [{ estado: 'EJECUTADA', resultado: { saldo: '790000.00', tasa: 0.25, movimientos: [{ monto: 2991000 }, { monto: 50000 }] } }];
    expect(cifrasSinRespaldo('El saldo es $790.000 y la tasa 0,25%.', datos)).toEqual([]);
    expect(cifrasSinRespaldo('Retiros por $2.991.000 y reintegro de $50.000.', datos)).toEqual([]);
    // La suma (3.041.000) no la entregó ninguna herramienta: el modelo no calcula.
    expect(cifrasSinRespaldo('En total, $3.041.000.', datos)).toEqual(['$3.041.000']);
    expect(cifrasSinRespaldo('El IVA es $123.456.', datos)).toEqual(['$123.456']);
    // Lo que dijo la persona también es fuente.
    expect(cifrasSinRespaldo('Registré los $81.000 que indicó.', ['La apertura es de $81.000'])).toEqual([]);
  });

  it('en una conversación, la respuesta con una cifra sin respaldo lleva el aviso y queda en las trazas', async () => {
    let respuesta = 'Según el balance, la caja tiene $1.234.567.';
    const modelo: ModeloIA = {
      async responder(p): Promise<RespuestaModelo> {
        const ultima = p.mensajes.at(-1);
        if (ultima?.rol === 'usuario') return { tipo: 'herramientas', llamadas: [{ id: 'l1', nombre: 'consultar_plan_cuentas', entrada: {} }] };
        return { tipo: 'texto', texto: respuesta };
      },
    };
    const r = await conversar(e.db, registro, modelo, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      mensaje: '¿Cuánto hay en caja?',
    });
    expect(r.cifrasSinRespaldo).toEqual(['$1.234.567']);
    expect(r.respuesta).toMatch(/⚠️ Contralor: no encontré respaldo .*\$1\.234\.567/u);
    const { rows } = await e.owner.query(`SELECT tipo, contenido FROM trazas_agente WHERE conversacion_id = $1 AND tipo = 'CONTROL_CIFRAS'`, [r.conversacionId]);
    expect(rows[0].contenido).toEqual({ cifrasSinRespaldo: ['$1.234.567'] });

    // Una respuesta sin cifras nuevas no lleva aviso.
    respuesta = 'La cuenta de caja es la 1.1.01.';
    const r2 = await conversar(e.db, registro, modelo, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      mensaje: '¿Cuál es la cuenta de caja?',
    });
    expect(r2.cifrasSinRespaldo).toEqual([]);
    expect(r2.respuesta).toBe(respuesta);
  });
});

describe('Contralor: revisión de propuestas', () => {
  it('una propuesta correcta llega como CONFORME y la revisión queda registrada', async () => {
    const r = await proponer(traspaso(100_000));
    expect(r).toMatchObject({ estado: 'PROPUESTA_CREADA', dictamenContralor: 'CONFORME', hallazgos: [] });
    if (r.estado !== 'PROPUESTA_CREADA') return;
    const { rows } = await e.owner.query(`SELECT dictamen, propuesta_id FROM revisiones_contralor WHERE propuesta_id = $1`, [r.propuestaId]);
    expect(rows).toEqual([{ dictamen: 'CONFORME', propuesta_id: r.propuestaId }]);
    // El ensayo no dejó rastros: ningún asiento, correlativo intacto, nada en la bitácora.
    const asientos = await e.owner.query(`SELECT count(*)::int AS n FROM asientos WHERE empresa_id = $1`, [e.empresaA1]);
    expect(asientos.rows[0]).toEqual({ n: 0 });
    const bitacora = await e.owner.query(`SELECT count(*)::int AS n FROM bitacora WHERE empresa_id = $1 AND accion = 'asiento.registrado'`, [e.empresaA1]);
    expect(bitacora.rows[0]).toEqual({ n: 0 });
    // Aprobada, se registra con el número 1 (el ensayo no consumió correlativos).
    const res = await resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, r.propuestaId, 'APROBAR');
    expect(res.estado).toBe('EJECUTADA');
    const { rows: a } = await e.owner.query(`SELECT numero, origen FROM asientos WHERE propuesta_id = $1`, [r.propuestaId]);
    expect(a).toEqual([{ numero: 1, origen: 'AGENTE' }]);
    const despues = await e.owner.query(`SELECT count(*)::int AS n FROM bitacora WHERE empresa_id = $1 AND accion = 'asiento.registrado'`, [e.empresaA1]);
    expect(despues.rows[0]).toEqual({ n: 1 });
  });

  it('lo que fallaría al aprobarse se rechaza antes: no llega a nadie y el agente sabe por qué', async () => {
    const r = await proponer({ fecha: '2026-10-15', glosa: 'Traspaso a cuenta inexistente', lineas: [{ cuenta: '9.9.99', debe: 5000 }, { cuenta: '1.1.01', haber: 5000 }] });
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'RECHAZADA_POR_CONTRALOR' });
    if (r.estado === 'DENEGADA') expect(r.mensaje).toMatch(/9\.9\.99/u);
    const { rows } = await e.owner.query(
      `SELECT dictamen, propuesta_id FROM revisiones_contralor WHERE empresa_id = $1 AND resumen LIKE '%inexistente%'`,
      [e.empresaA1],
    );
    expect(rows).toEqual([{ dictamen: 'RECHAZADA', propuesta_id: null }]);
    const p = await e.owner.query(`SELECT count(*)::int AS n FROM propuestas_agente WHERE resumen LIKE '%inexistente%'`);
    expect(p.rows[0]).toEqual({ n: 0 });
    // La identidad declarada de la transacción volvió a ser la del agente tras el ensayo.
    const { rows: t } = await e.owner.query(
      `SELECT count(*)::int AS n FROM trazas_agente WHERE empresa_id = $1 AND tipo = 'REVISION_CONTRALOR' AND contenido->>'dictamen' = 'RECHAZADA'`,
      [e.empresaA1],
    );
    expect(t[0].n).toBeGreaterThan(0);
  });

  it('una propuesta idéntica a otra pendiente se rechaza por duplicada', async () => {
    const entrada = traspaso(7_000, 'Depósito de caja duplicado de prueba');
    expect((await proponer(entrada)).estado).toBe('PROPUESTA_CREADA');
    const r = await proponer(entrada);
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'RECHAZADA_POR_CONTRALOR' });
    if (r.estado === 'DENEGADA') expect(r.mensaje).toMatch(/propuesta idéntica pendiente/u);
  });

  it('con observaciones (monto relevante, fecha antigua, glosa breve), aprobar exige motivo', async () => {
    const r = await proponer(traspaso(12_000_000, 'Depósito', '2026-01-10'));
    expect(r).toMatchObject({ estado: 'PROPUESTA_CREADA', dictamenContralor: 'OBSERVADA' });
    if (r.estado !== 'PROPUESTA_CREADA') return;
    expect(r.hallazgos.map((h) => h.codigo).sort()).toEqual(['FECHA_ANTIGUA', 'GLOSA_INSUFICIENTE', 'MONTO_RELEVANTE']);
    const revisor = { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 };
    await expect(resolverPropuesta(e.db, registro, revisor, r.propuestaId, 'APROBAR')).rejects.toThrow(/indique por qué/u);
    const res = await resolverPropuesta(e.db, registro, revisor, r.propuestaId, 'APROBAR', 'Depósito del aporte de capital, verificado con la cartola');
    expect(res.estado).toBe('EJECUTADA');
    // El dictamen no se puede cambiar después, ni siquiera por la plataforma.
    await expect(e.owner.query(`UPDATE propuestas_agente SET dictamen_contralor = 'CONFORME' WHERE id = $1`, [r.propuestaId])).rejects.toThrow(
      /no se modifica/u,
    );
    await expect(e.owner.query(`DELETE FROM revisiones_contralor WHERE propuesta_id = $1`, [r.propuestaId])).rejects.toThrow(/no se modifican/u);
  });

  it('el umbral de revisión se configura por empresa y agente', async () => {
    await e.owner.query(
      `INSERT INTO agentes_config_empresa (empresa_id, agente_codigo, parametros) VALUES ($1, 'CONTADOR_GENERAL', '{"umbral_observacion_asiento": 50000}')`,
      [e.empresaA1],
    );
    const r = await proponer(traspaso(60_000, 'Depósito de caja por ventas del día 15'));
    expect(r).toMatchObject({ estado: 'PROPUESTA_CREADA', dictamenContralor: 'OBSERVADA' });
    if (r.estado === 'PROPUESTA_CREADA') expect(r.hallazgos.map((h) => h.codigo)).toEqual(['MONTO_RELEVANTE']);
  });

  it('el Contralor responde con las revisiones que la persona puede ver', async () => {
    const usar = (usuarioId: string) =>
      ejecutarHerramienta(e.db, registro, {
        agenteCodigo: 'CONTRALOR',
        solicitante: { usuarioId, empresaId: e.empresaA1 },
        nombre: 'consultar_revisiones_contralor',
        entrada: { dictamen: 'RECHAZADA' },
        fecha: HOY,
      });
    const r = await usar(e.usuarios.contadorA1.id);
    expect(r.estado).toBe('EJECUTADA');
    if (r.estado === 'EJECUTADA') expect((r.resultado as { total: number }).total).toBeGreaterThanOrEqual(2);
    // Quien no aprueba ni originó revisiones no ve las de otros.
    const otro = await usar(e.usuarios.colaboradorA1.id);
    if (otro.estado === 'EJECUTADA') expect((otro.resultado as { total: number }).total).toBe(0);
  });
});
