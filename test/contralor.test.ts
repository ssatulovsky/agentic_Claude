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

  it('identificadores, marcas de tiempo y el signo no sirven de respaldo', () => {
    const datos = [{ id: '0f9a550e-8400-4e29-b1d4-446655440000', creado_en: '2026-10-23T14:05:59.000Z', resultado: '-5000000.00', folio: 4321 }];
    expect(cifrasSinRespaldo('Hay $8.400 y un margen de 23%; el folio es 4321.', datos)).toEqual(['$8.400', '23%']);
    expect(cifrasSinRespaldo('$446.655.440.000', datos)).toEqual(['$446.655.440.000']);
    // Una pérdida informada como utilidad se marca; dicha como pérdida, no.
    expect(cifrasSinRespaldo('La utilidad del ejercicio es $5.000.000.', datos)).toEqual(['$5.000.000']);
    expect(cifrasSinRespaldo('El ejercicio tiene una pérdida de $5.000.000.', datos)).toEqual([]);
    expect(cifrasSinRespaldo('Resultado: -$5.000.000.', datos)).toEqual([]);
  });

  it('entiende millones, MM$, decimales con punto en porcentajes y miles con coma', () => {
    const datos = [{ saldo: 2_876_000, tasa: 12.5, total: 1_234_567 }];
    expect(cifrasSinRespaldo('Unos $2,9 millones, tasa 12.5% y total $1,234,567.', datos)).toEqual([]);
    expect(cifrasSinRespaldo('MM$ 2,9 en caja.', datos)).toEqual([]);
    // Redondear a una sola cifra significativa ya no es decir el dato.
    expect(cifrasSinRespaldo('Unos $3 millones.', datos)).toEqual(['$3 millones']);
    expect(cifrasSinRespaldo('Tasa de 13.75%.', datos)).toEqual(['13.75%']);
    // Las cuentas se reconocen por su forma o por la palabra "cuenta".
    expect(cifrasSinRespaldo('Use la cuenta 4.1 o la 1.1.02.', datos)).toEqual([]);
  });

  it('el control es rápido con resultados grandes', () => {
    const datos = Array.from({ length: 50 }, (_x, i) => ({ filas: Array.from({ length: 2000 }, (_y, j) => ({ monto: i * 100_000 + j * 7, saldo: j * 13 })) }));
    const texto = Array.from({ length: 40 }, (_x, i) => `$${(i * 123_457).toLocaleString('es-CL')}`).join(', ');
    const inicio = Date.now();
    cifrasSinRespaldo(texto, datos);
    expect(Date.now() - inicio).toBeLessThan(500);
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

  it('dos propuestas idénticas al mismo tiempo: solo una llega', async () => {
    const entrada = traspaso(9_000, 'Depósito simultáneo de prueba de concurrencia');
    const [a, b] = await Promise.all([proponer(entrada), proponer(entrada)]);
    expect([a.estado, b.estado].sort()).toEqual(['DENEGADA', 'PROPUESTA_CREADA']);
  });

  it('si al aprobar falla, se conserva el motivo de quien aprobó y el error queda en el resultado', async () => {
    const r = await proponer(traspaso(11_000, 'Depósito que fallará al aprobarse'));
    if (r.estado !== 'PROPUESTA_CREADA') throw new Error(r.estado);
    // Entre la propuesta y la aprobación, la cuenta deja de ser imputable.
    await e.owner.query(`UPDATE plan_cuentas SET imputable = false WHERE empresa_id = $1 AND codigo = '1.1.02'`, [e.empresaA1]);
    const res = await resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, r.propuestaId, 'APROBAR', 'Revisado con la cartola');
    await e.owner.query(`UPDATE plan_cuentas SET imputable = true WHERE empresa_id = $1 AND codigo = '1.1.02'`, [e.empresaA1]);
    expect(res.estado).toBe('FALLIDA');
    const { rows } = await e.owner.query(`SELECT motivo, resultado->>'error' AS error FROM propuestas_agente WHERE id = $1`, [r.propuestaId]);
    expect(rows[0].motivo).toBe('Revisado con la cartola');
    expect(rows[0].error).toBeTruthy();
  });

  it('si a quien pidió le falta un permiso de la acción, el ensayo deja una observación (no un rechazo)', async () => {
    const { RegistroAgentes: Registro } = await import('../src/agentes/catalogo.js');
    const { sinPermiso } = await import('../src/errores.js');
    const { z } = await import('zod');
    const propia = new Registro(
      [
        {
          nombre: 'accion_con_otro_permiso',
          descripcion: 'Prueba',
          modulo: null,
          permiso: 'agentes.consultar',
          autonomia: 'PROPONER',
          entrada: z.object({ x: z.number() }),
          async ejecutar() {
            throw sinPermiso('contabilidad.asientos.registrar');
          },
        },
      ],
      [{ codigo: 'AGENTE_PRUEBA', cargo: 'Prueba', descripcion: 'Prueba', instrucciones: 'x', herramientas: ['accion_con_otro_permiso'] }],
    );
    const r = await ejecutarHerramienta(e.db, propia, {
      agenteCodigo: 'AGENTE_PRUEBA',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      nombre: 'accion_con_otro_permiso',
      entrada: { x: 1 },
      fecha: HOY,
    });
    expect(r).toMatchObject({ estado: 'PROPUESTA_CREADA', dictamenContralor: 'OBSERVADA' });
    if (r.estado === 'PROPUESTA_CREADA') expect(r.hallazgos.map((h) => h.codigo)).toEqual(['REQUIERE_APROBADOR_CON_PERMISO']);
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
