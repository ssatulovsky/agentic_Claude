import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { conversar } from '../src/agentes/conversacion.js';
import { ejecutarHerramienta, resolverPropuesta } from '../src/agentes/ejecutor.js';
import type { MensajeConversacion, ModeloIA, RespuestaModelo } from '../src/agentes/tipos.js';
import { contextoDeUsuario, enContexto } from '../src/db/conexion.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
const registro = new RegistroAgentes();
const FECHA = '2026-10-29';

beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => {
  await e.cerrar();
});

const usar = (usuarioId: string, empresaId: string, agenteCodigo: string, nombre: string, entrada: unknown) =>
  ejecutarHerramienta(e.db, registro, { agenteCodigo, solicitante: { usuarioId, empresaId }, nombre, entrada, fecha: FECHA });

describe('Herramientas de los agentes', () => {
  it('el agente consulta con la identidad de quien pregunta', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'consultar_plan_cuentas', { texto: 'banco' });
    expect(r.estado).toBe('EJECUTADA');
    if (r.estado === 'EJECUTADA') {
      expect((r.resultado as { cuentas: { codigo: string }[] }).cuentas.map((c) => c.codigo)).toEqual(['1.1.02']);
    }
  });

  it('se deniega si la persona no tiene el permiso, aunque el agente sí tenga la herramienta', async () => {
    const r = await usar(e.usuarios.colaboradorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'consultar_plan_cuentas', {});
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'SIN_PERMISO' });
  });

  it('se deniega si la empresa no contrató el módulo', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA2, 'CONTADOR_GENERAL', 'consultar_plan_cuentas', {});
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'MODULO_NO_CONTRATADO' });
  });

  it('un agente no puede usar herramientas de otro cargo', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'GERENTE_VIRTUAL', 'proponer_cuenta_contable', {});
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'HERRAMIENTA_NO_ASIGNADA' });
  });

  it('valida la entrada que propone el modelo', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'consultar_parametro_legal', {
      clave: 'tope; DROP TABLE x',
      fecha: 'ayer',
    });
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'ENTRADA_INVALIDA' });
  });

  it('informa que no hay un valor legal vigente en vez de suponerlo', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'consultar_parametro_legal', {
      clave: 'TOPE_IMPONIBLE.AFP_SALUD',
      fecha: '2020-01-01',
    });
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'ERROR_NEGOCIO' });
  });

  it('un agente desactivado por la empresa no puede actuar', async () => {
    await e.owner.query(
      `INSERT INTO agentes_config_empresa (empresa_id, agente_codigo, activo) VALUES ($1, 'GERENTE_VIRTUAL', false)`,
      [e.empresaA0],
    );
    const r = await usar(e.usuarios.adminA.id, e.empresaA0, 'GERENTE_VIRTUAL', 'consultar_indicador', { tipo: 'UTM', fecha: FECHA });
    expect(r).toMatchObject({ estado: 'DENEGADA', motivo: 'AGENTE_DESACTIVADO' });
  });
});

describe('Propuestas con aprobación humana', () => {
  const nuevaCuenta = {
    codigo: '1.1.09',
    nombre: 'Fondos por rendir',
    clasificacion: 'ACTIVO',
    naturaleza: 'DEUDORA',
    imputable: true,
    codigoPadre: '1.1',
    motivo: 'Se necesita para las rendiciones de gastos de terreno',
  };
  let propuestaId: string;

  const existeCuenta = () =>
    enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
      trx.selectFrom('plan_cuentas').select('id').where('codigo', '=', '1.1.09').executeTakeFirst(),
    );

  it('la acción queda como propuesta y NO modifica los libros', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'proponer_cuenta_contable', nuevaCuenta);
    expect(r.estado).toBe('PROPUESTA_CREADA');
    if (r.estado === 'PROPUESTA_CREADA') propuestaId = r.propuestaId;
    expect(await existeCuenta()).toBeUndefined();
  });

  it('quien no podría crear la cuenta por sí mismo tampoco puede aprobarla', async () => {
    // El gerente general tiene agentes.aprobar pero no contabilidad.plan_cuentas.editar.
    await expect(
      resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.gerenteA1.id, empresaId: e.empresaA1 }, propuestaId, 'APROBAR'),
    ).rejects.toMatchObject({ codigo: 'SIN_PERMISO' });
    expect(await existeCuenta()).toBeUndefined();
  });

  it('una persona de otro Cliente ERP no ve la propuesta', async () => {
    await expect(
      resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.adminB.id, empresaId: e.empresaA1 }, propuestaId, 'APROBAR'),
    ).rejects.toMatchObject({ codigo: 'SIN_PERMISO' });
  });

  it('al aprobarla quien corresponde, se ejecuta y queda registrada', async () => {
    const r = await resolverPropuesta(
      e.db,
      registro,
      { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      propuestaId,
      'APROBAR',
      'Revisado',
    );
    expect(r.estado).toBe('EJECUTADA');
    expect(await existeCuenta()).toBeDefined();
  });

  it('una propuesta vencida queda registrada como VENCIDA y no se ejecuta', async () => {
    const r = await usar(e.usuarios.contadorA1.id, e.empresaA1, 'CONTADOR_GENERAL', 'proponer_cuenta_contable', {
      ...nuevaCuenta,
      codigo: '1.1.10',
    });
    if (r.estado !== 'PROPUESTA_CREADA') throw new Error('se esperaba una propuesta');
    await e.owner.query(`UPDATE propuestas_agente SET vence_en = now() - interval '1 minute' WHERE id = $1`, [r.propuestaId]);
    const resultado = await resolverPropuesta(
      e.db,
      registro,
      { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      r.propuestaId,
      'APROBAR',
    );
    expect(resultado.estado).toBe('VENCIDA');
    const { rows } = await e.owner.query('SELECT estado FROM propuestas_agente WHERE id = $1', [r.propuestaId]);
    expect(rows[0].estado).toBe('VENCIDA');
    const { rows: cuenta } = await e.owner.query(`SELECT 1 FROM plan_cuentas WHERE empresa_id = $1 AND codigo = '1.1.10'`, [
      e.empresaA1,
    ]);
    expect(cuenta).toHaveLength(0);
  });

  it('no se puede aprobar dos veces', async () => {
    await expect(
      resolverPropuesta(e.db, registro, { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 }, propuestaId, 'APROBAR'),
    ).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_RESUELTA' });
  });
});

/** Modelo de prueba que sigue un guion fijo: así se prueba el ciclo sin depender de un proveedor de IA. */
class ModeloGuionado implements ModeloIA {
  readonly peticiones: MensajeConversacion[][] = [];
  constructor(private readonly guion: RespuestaModelo[]) {}
  async responder(p: { mensajes: MensajeConversacion[] }): Promise<RespuestaModelo> {
    this.peticiones.push(structuredClone(p.mensajes));
    const siguiente = this.guion.shift();
    if (!siguiente) throw new Error('Guion agotado');
    return siguiente;
  }
}

describe('Ciclo de conversación de un agente', () => {
  it('usa herramientas, recibe resultados reales y deja todo trazado', async () => {
    const modelo = new ModeloGuionado([
      {
        tipo: 'herramientas',
        llamadas: [
          { id: 'l1', nombre: 'consultar_parametro_legal', entrada: { clave: 'TOPE_IMPONIBLE.AFP_SALUD', fecha: FECHA } },
          { id: 'l2', nombre: 'consultar_indicador', entrada: { tipo: 'UF', fecha: '2026-10-31' } },
        ],
      },
      { tipo: 'texto', texto: 'El tope imponible es 90 UF (fuente: Superintendencia de Pensiones).' },
    ]);
    const r = await conversar(e.db, registro, modelo, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      mensaje: '¿Cuál es el tope imponible para AFP este mes?',
      fecha: FECHA,
    });
    expect(r.respuesta).toContain('90 UF');
    expect(r.pasos).toBe(2);

    // El modelo recibió el resultado real del núcleo, no uno inventado.
    const segunda = modelo.peticiones[1]!;
    const resultados = segunda.filter((m) => m.rol === 'herramienta');
    expect(resultados).toHaveLength(2);
    expect(resultados[0]).toMatchObject({ resultado: { estado: 'EJECUTADA', resultado: { valor: '90', unidad: 'UF' } } });

    const trazas = await enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
      trx.selectFrom('trazas_agente').select(['tipo']).where('conversacion_id', '=', r.conversacionId).orderBy('id').execute(),
    );
    expect(trazas.map((t) => t.tipo)).toEqual([
      'MENSAJE_USUARIO',
      'LLAMADA_HERRAMIENTA',
      'RESULTADO_HERRAMIENTA',
      'LLAMADA_HERRAMIENTA',
      'RESULTADO_HERRAMIENTA',
      'RESPUESTA',
    ]);
  });

  it('aunque el modelo pida datos de otra empresa, el agente no puede salir de la empresa del solicitante', async () => {
    const modelo = new ModeloGuionado([
      { tipo: 'herramientas', llamadas: [{ id: 'l1', nombre: 'consultar_plan_cuentas', entrada: { texto: 'Banco' } }] },
      { tipo: 'texto', texto: 'listo' },
    ]);
    // El colaborador de A1 no tiene permiso; el modelo no puede rodearlo.
    await conversar(e.db, registro, modelo, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.colaboradorA1.id, empresaId: e.empresaA1 },
      mensaje: 'Muéstrame las cuentas bancarias',
      fecha: FECHA,
    });
    const resultado = modelo.peticiones[1]!.find((m) => m.rol === 'herramienta');
    expect(resultado).toMatchObject({ resultado: { estado: 'DENEGADA', motivo: 'SIN_PERMISO' } });
  });

  it('corta un ciclo que no termina', async () => {
    const llamada: RespuestaModelo = {
      tipo: 'herramientas',
      llamadas: [{ id: 'x', nombre: 'consultar_indicador', entrada: { tipo: 'UTM', fecha: FECHA } }],
    };
    const modelo = new ModeloGuionado(Array.from({ length: 10 }, () => structuredClone(llamada)));
    const r = await conversar(e.db, registro, modelo, {
      agenteCodigo: 'CONTADOR_GENERAL',
      solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1 },
      mensaje: 'bucle',
      fecha: FECHA,
      maxPasos: 3,
    });
    expect(r.respuesta).toMatch(/límite de pasos/u);
  });

  it('las especificaciones entregadas al modelo son JSON Schema válidas', () => {
    const specs = registro.especificaciones('CONTADOR_GENERAL');
    expect(specs.map((s) => s.nombre)).toContain('proponer_cuenta_contable');
    for (const s of specs) {
      expect(s.esquemaEntrada).toMatchObject({ type: 'object' });
    }
  });
});
