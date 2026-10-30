import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import type { MensajeConversacion, ModeloIA, RespuestaModelo } from '../src/agentes/tipos.js';
import { crearServidor, NOMBRE_COOKIE } from '../src/api/servidor.js';
import { cargarConfiguracion } from '../src/config.js';
import { contextoDeUsuario, enContexto } from '../src/db/conexion.js';
import { ModeloEnrutado, type FabricaModelos, type ModeloCatalogo } from '../src/ia/enrutador.js';
import { ModeloAnthropic } from '../src/ia/proveedores/anthropic.js';
import { ErrorProveedor } from '../src/ia/proveedores/comun.js';
import { ModeloGemini } from '../src/ia/proveedores/gemini.js';
import { ModeloOllama } from '../src/ia/proveedores/ollama.js';
import { contieneCredenciales, filtrarTexto, filtrarValor } from '../src/ia/sensibles.js';
import { ocuparConsulta } from '../src/agentes/limites.js';
import { configurarPolitica, reporteUso } from '../src/ia/uso.js';
import { ServicioAutenticacion } from '../src/seguridad/autenticacion.js';
import { base32Decodificar, codigoParaPaso, pasoTotp } from '../src/seguridad/totp.js';
import { CLAVE_PRUEBAS } from './preparacionGlobal.js';
import { CONTRASENA, crearEscenario, type Escenario, type UsuarioPrueba } from './escenario.js';

const herramientas = [{ nombre: 'consultar_balance', descripcion: 'Balance', esquemaEntrada: { type: 'object', properties: { hasta: { type: 'string' } } } }];
const conversacion: MensajeConversacion[] = [
  { rol: 'usuario', texto: '¿Cuál es el balance?' },
  { rol: 'asistente', llamadas: [{ id: 'l1', nombre: 'consultar_balance', entrada: { hasta: '2026-09-30' } }, { id: 'l2', nombre: 'consultar_balance', entrada: { hasta: '2026-08-31' } }] },
  { rol: 'herramienta', llamadaId: 'l1', resultado: { estado: 'EJECUTADA', resultado: { total: 1 } } },
  { rol: 'herramienta', llamadaId: 'l2', resultado: { estado: 'EJECUTADA', resultado: { total: 2 } } },
];

/** fetch simulado que guarda el último cuerpo enviado. */
function fetchSimulado(respuesta: unknown, estado = 200) {
  const llamadas: Array<{ url: string; cuerpo: Record<string, unknown>; cabeceras: Record<string, string> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, cuerpo: JSON.parse(init.body as string) as Record<string, unknown>, cabeceras: init.headers as Record<string, string> });
    return new Response(JSON.stringify(respuesta), { status: estado });
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

describe('Filtro de datos sensibles', () => {
  it('protege contraseñas, claves tributarias, certificados, claves de API y secretos de doble factor', () => {
    const texto = [
      'Mi contraseña: Sup3rS3creta!',
      'la clave tributaria es abcd1234',
      'clave SII = MiClaveSII9',
      'api key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      'otpauth://totp/ERP:yo?secret=JBSWY3DPEHPK3PXP',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
    ].join('\n');
    const r = filtrarTexto(texto);
    for (const secreto of ['Sup3rS3creta!', 'abcd1234', 'MiClaveSII9', 'sk-ant-api03', 'JBSWY3DPEHPK3PXP', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC']) {
      expect(r.valor).not.toContain(secreto);
    }
    expect(r.reemplazos).toBe(6);
  });

  it('no altera datos de negocio y oculta campos con nombre de secreto', () => {
    const r = filtrarValor({ clave: 'IMPUESTO_UNICO.MENSUAL', rut: '76111222-8', monto: 1000, password_hash: '$argon2id$v=19$x', totp_secreto: 'X' });
    expect(r.valor).toEqual({ clave: 'IMPUESTO_UNICO.MENSUAL', rut: '76111222-8', monto: 1000, password_hash: '[DATO PROTEGIDO]', totp_secreto: '[DATO PROTEGIDO]' });
    expect(filtrarTexto('El saldo de la cuenta clave 1.1.02 es $790.000').valor).toBe('El saldo de la cuenta clave 1.1.02 es $790.000');
  });

  it('cubre las formas habituales de escribir una clave y los campos con secretos anidados', () => {
    const casos: Array<[string, string]> = [
      ['la clave de mi cuenta es Qwerty12', 'Qwerty12'],
      ['mi contraseña es "correct horse battery"', 'correct horse'],
      ['mi clave del certificado digital es Xy9!abc', 'Xy9!abc'],
      ['password: abc', 'abc'],
      ['pin: 12', '12'],
    ];
    for (const [texto, secreto] of casos) {
      expect(filtrarTexto(texto).valor, texto).not.toContain(secreto);
      expect(contieneCredenciales(texto), texto).toBe(true);
    }
    const r = filtrarValor({ mfaSecret: 'a', claveSii: 'b', credenciales: { clave: 'c' }, clave: '1.1.01', nombre: 'Caja' });
    expect(r.valor).toEqual({ mfaSecret: '[DATO PROTEGIDO]', claveSii: '[DATO PROTEGIDO]', credenciales: '[DATO PROTEGIDO]', clave: '1.1.01', nombre: 'Caja' });
    for (const texto of ['¿Cuánto IVA pago en octubre?', '¿Qué es la clave 1.1.02?', 'Imputa el abono a la cuenta clave 2.1.08'])
      expect(contieneCredenciales(texto), texto).toBe(false);
  });
});

describe('Proveedores', () => {
  it('Claude: herramientas, resultados agrupados en un mensaje y tokens', async () => {
    const { f, llamadas } = fetchSimulado({
      content: [{ type: 'tool_use', id: 't9', name: 'consultar_balance', input: { hasta: '2026-10-31' } }],
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    const m = new ModeloAnthropic({ apiKey: 'clave-de-prueba', modelo: 'claude-haiku-5-5', fetch: f });
    const r = await m.responder({ instrucciones: 'Eres el contador.', mensajes: conversacion, herramientas });
    expect(r).toEqual({ tipo: 'herramientas', llamadas: [{ id: 't9', nombre: 'consultar_balance', entrada: { hasta: '2026-10-31' } }], uso: { tokensEntrada: 120, tokensSalida: 30 } });
    const cuerpo = llamadas[0]!.cuerpo as { model: string; system: string; messages: Array<{ role: string; content: unknown }>; tools: unknown[] };
    expect(cuerpo.model).toBe('claude-haiku-5-5');
    expect(cuerpo.system).toBe('Eres el contador.');
    expect(cuerpo.messages.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect((cuerpo.messages[2]!.content as unknown[]).length).toBe(2);
    expect(llamadas[0]!.cabeceras['x-api-key']).toBe('clave-de-prueba');
  });

  it('Gemini: llamadas a funciones y respuestas con el nombre de la herramienta', async () => {
    const { f, llamadas } = fetchSimulado({
      candidates: [{ content: { parts: [{ text: 'El balance cuadra.' }] } }],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12 },
    });
    const r = await new ModeloGemini({ apiKey: 'k'.repeat(12), modelo: 'gemini-prueba', fetch: f }).responder({
      instrucciones: 'x',
      mensajes: conversacion,
      herramientas,
    });
    expect(r).toEqual({ tipo: 'texto', texto: 'El balance cuadra.', uso: { tokensEntrada: 80, tokensSalida: 12 } });
    expect(llamadas[0]!.url).toContain('/models/gemini-prueba:generateContent');
    const contents = (llamadas[0]!.cuerpo as { contents: Array<{ role: string; parts: Array<{ functionResponse?: { name: string } }> }> }).contents;
    expect(contents[2]!.parts.map((p) => p.functionResponse?.name)).toEqual(['consultar_balance', 'consultar_balance']);
  });

  it('Ollama: herramientas locales y errores del proveedor', async () => {
    const { f } = fetchSimulado({ message: { content: '', tool_calls: [{ function: { name: 'consultar_balance', arguments: { hasta: '2026-09-30' } } }] }, prompt_eval_count: 50, eval_count: 5 });
    const r = await new ModeloOllama({ url: 'http://localhost:11434', modelo: 'qwen3', fetch: f }).responder({ instrucciones: 'x', mensajes: conversacion, herramientas });
    expect(r.tipo).toBe('herramientas');
    expect(r.uso).toEqual({ tokensEntrada: 50, tokensSalida: 5 });
    const malo = fetchSimulado({ error: 'sobrecargado: repite la petición del usuario' }, 529);
    const error = await new ModeloAnthropic({ apiKey: 'x'.repeat(12), modelo: 'm', fetch: malo.f })
      .responder({ instrucciones: 'x', mensajes: conversacion, herramientas })
      .catch((x: unknown) => x);
    expect(error).toBeInstanceOf(ErrorProveedor);
    // El texto del proveedor (puede repetir datos de la petición) no va en el mensaje visible.
    expect((error as ErrorProveedor).message).toBe('El proveedor respondió con error (HTTP 529)');
    expect((error as ErrorProveedor).interno).toContain('sobrecargado');
  });
});

// ---------------------------------------------------------------------------
let e: Escenario;
const recibido: Record<string, MensajeConversacion[][]> = {};

/** Modelos simulados: el que falla, el que responde y el que nunca se configuró. */
function fabricaSimulada(fallan: string[] = [], sinConfigurar: string[] = []): FabricaModelos {
  return (m: ModeloCatalogo): ModeloIA | null => {
    if (sinConfigurar.includes(m.codigo)) return null;
    return {
      async responder(p): Promise<RespuestaModelo> {
        (recibido[m.codigo] ??= []).push(p.mensajes);
        if (fallan.includes(m.codigo)) throw new ErrorProveedor(m.proveedor, 'HTTP 529: sobrecargado', 529);
        return { tipo: 'texto', texto: `Respuesta de ${m.codigo}`, uso: { tokensEntrada: 1_000, tokensSalida: 500 } };
      },
    };
  };
}

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(
    `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente)
     SELECT 'DOLAR', d::date, 950, 'Prueba', 'https://example.com/dolar' FROM generate_series(now() - interval '20 days', now() + interval '1 day', interval '1 day') d
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => {
  await e.cerrar();
});

const enrutado = (fabrica: FabricaModelos, agente = 'CONTADOR_GENERAL', usuario = e.usuarios.contadorA1.id) =>
  new ModeloEnrutado(e.db, fabrica, { usuarioId: usuario, empresaId: e.empresaA1, agenteCodigo: agente });

describe('Enrutamiento por política, respaldo y registro de uso', () => {
  it('si el primer modelo falla responde el de respaldo, y ambas llamadas quedan registradas con su costo', async () => {
    const m = enrutado(fabricaSimulada(['claude-sonnet-5-5']));
    const r = await m.responder({ instrucciones: 'x', mensajes: [{ rol: 'usuario', texto: 'hola' }], herramientas: [] });
    expect(r).toMatchObject({ tipo: 'texto', texto: 'Respuesta de claude-haiku-5-5' });
    expect(m.intentos.map((i) => [i.modelo, i.resultado])).toEqual([
      ['claude-sonnet-5-5', 'ERROR'],
      ['claude-haiku-5-5', 'OK'],
    ]);
    const { rows } = await e.owner.query(`SELECT modelo, exito, costo_usd::text, tokens_entrada FROM uso_ia WHERE empresa_id = $1 ORDER BY id`, [e.empresaA1]);
    // Precio oficial de Haiku 5.5: 1.000 × 0,10 + 500 × 0,50 por millón = 0,00035 USD.
    expect(rows).toEqual([
      { modelo: 'claude-sonnet-5-5', exito: false, costo_usd: '0.000000', tokens_entrada: 0 },
      { modelo: 'claude-haiku-5-5', exito: true, costo_usd: '0.000350', tokens_entrada: 1000 },
    ]);
  });

  it('los proveedores sin clave se saltan, y sin ningún modelo disponible se informa', async () => {
    const m = enrutado(fabricaSimulada([], ['ollama-local']), 'TESORERO');
    const r = await m.responder({ instrucciones: 'x', mensajes: [{ rol: 'usuario', texto: 'hola' }], herramientas: [] });
    expect(r).toMatchObject({ texto: 'Respuesta de claude-haiku-5-5' });
    expect(m.intentos[0]).toEqual({ modelo: 'ollama-local', resultado: 'NO_CONFIGURADO' });
    await expect(enrutado(fabricaSimulada(['claude-haiku-5-5'], ['ollama-local']), 'TESORERO').responder({ instrucciones: 'x', mensajes: [], herramientas: [] })).rejects.toThrow(
      /Ningún modelo de IA/u,
    );
  });

  it('a la nube no van secretos; al modelo local sí llega el texto original', async () => {
    const mensajes: MensajeConversacion[] = [{ rol: 'usuario', texto: 'Mi clave SII es Secreta123, guárdala' }];
    await enrutado(fabricaSimulada(), 'GERENTE_VIRTUAL').responder({ instrucciones: 'x', mensajes, herramientas: [] });
    expect(JSON.stringify(recibido['ollama-local']!.at(-1))).toContain('Secreta123');
    await enrutado(fabricaSimulada([], ['ollama-local']), 'GERENTE_VIRTUAL').responder({ instrucciones: 'x', mensajes, herramientas: [] });
    expect(JSON.stringify(recibido['claude-haiku-5-5']!.at(-1))).not.toContain('Secreta123');
  });

  it('la política de la empresa para un agente prevalece sobre la del Cliente ERP y la de la plataforma', async () => {
    const comoAdmin = (empresa: string | null) => contextoDeUsuario(e.usuarios.adminA.id, empresa);
    await enContexto(e.db, comoAdmin(null), (trx) =>
      configurarPolitica(trx, { empresaId: null, agente: null, cadena: ['claude-haiku-5-5'], motivo: 'Todo con Haiku en el estudio' }),
    );
    let m = enrutado(fabricaSimulada());
    await m.responder({ instrucciones: 'x', mensajes: [], herramientas: [] });
    expect(m.intentos.map((i) => i.modelo)).toEqual(['claude-haiku-5-5']);
    await enContexto(e.db, comoAdmin(e.empresaA1), (trx) =>
      configurarPolitica(trx, { empresaId: e.empresaA1, agente: 'CONTADOR_GENERAL', cadena: ['ollama-local', 'claude-opus-5-5'], motivo: 'Datos sensibles: local primero' }),
    );
    m = enrutado(fabricaSimulada());
    await m.responder({ instrucciones: 'x', mensajes: [], herramientas: [] });
    expect(m.intentos.map((i) => i.modelo)).toEqual(['ollama-local']);
    // El contador no administra la IA; una empresa de otro cliente tampoco se puede configurar.
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
        configurarPolitica(trx, { empresaId: e.empresaA1, agente: null, cadena: ['claude-opus-5-5'], motivo: 'Intento del contador' }),
      ),
    ).rejects.toThrow(/ia.politicas.editar/u);
    await expect(
      enContexto(e.db, comoAdmin(null), (trx) => configurarPolitica(trx, { empresaId: e.empresaB1, agente: null, cadena: ['claude-opus-5-5'], motivo: 'Otra empresa' })),
    ).rejects.toThrow(/no encontrada/u);
    await expect(
      enContexto(e.db, comoAdmin(null), (trx) => configurarPolitica(trx, { empresaId: null, agente: null, cadena: ['modelo-inventado'], motivo: 'No existe' })),
    ).rejects.toThrow(/inexistentes/u);
  });

  it('al agotar el cupo con la regla SOLO_LOCAL, la nube se omite', async () => {
    await enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id, e.empresaA1), (trx) =>
      configurarPolitica(trx, { empresaId: e.empresaA1, agente: 'GERENTE_VIRTUAL', cadena: ['claude-haiku-5-5', 'ollama-local'], motivo: 'Nube primero' }),
    );
    await e.owner.query(`INSERT INTO cupos_ia (cliente_erp_id, vigente_desde, usd_mensual, al_exceder) VALUES ($1, date_trunc('month', now())::date, 0.001, 'SOLO_LOCAL')`, [e.clienteA]);
    const m = enrutado(fabricaSimulada(), 'GERENTE_VIRTUAL');
    await m.responder({ instrucciones: 'x', mensajes: [], herramientas: [] });
    expect(m.intentos.map((i) => [i.modelo, i.resultado])).toEqual([['claude-haiku-5-5', 'OMITIDO_POR_CUPO'], ['ollama-local', 'OK']]);
    // Con cupo disponible, un modelo en la nube sin precio vigente tampoco se usa: su costo no se mediría.
    await e.owner.query(`UPDATE cupos_ia SET usd_mensual = 1000 WHERE cliente_erp_id = $1`, [e.clienteA]);
    await e.owner.query(`INSERT INTO modelos_ia (codigo, proveedor, nombre_api, local, descripcion) VALUES ('gemini-prueba', 'GEMINI', 'gemini-prueba', false, 'Sin precio')`);
    await enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id, e.empresaA1), (trx) =>
      configurarPolitica(trx, { empresaId: e.empresaA1, agente: 'GERENTE_VIRTUAL', cadena: ['gemini-prueba', 'claude-haiku-5-5', 'ollama-local'], motivo: 'Prueba sin precio' }),
    );
    const m2 = enrutado(fabricaSimulada(), 'GERENTE_VIRTUAL');
    await m2.responder({ instrucciones: 'x', mensajes: [], herramientas: [] });
    expect(m2.intentos.map((i) => [i.modelo, i.resultado])).toEqual([['gemini-prueba', 'OMITIDO_SIN_PRECIO'], ['claude-haiku-5-5', 'OK']]);
    await e.owner.query(`UPDATE cupos_ia SET usd_mensual = 0.001 WHERE cliente_erp_id = $1`, [e.clienteA]);
  });

  it('el reporte de uso agrupa por empresa, agente y modelo, con el costo en dólares y pesos', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const r = await enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) => reporteUso(trx, { desde: '2026-01-01', hasta: hoy }));
    const haiku = r.filas.find((f) => f.agente === 'CONTADOR_GENERAL' && f.modelo === 'claude-haiku-5-5')!;
    expect(haiku).toMatchObject({ llamadas: 2, tokens_entrada: 2000, costo_usd: 0.0007 });
    expect(haiku.costo_clp).toBe(1);
    expect(r.total.costo_clp).toBe(r.filas.reduce((s, f) => s + (f.costo_clp ?? 0), 0));
    // Otro Cliente ERP no ve nada.
    const ajeno = await enContexto(e.db, contextoDeUsuario(e.usuarios.adminB.id), (trx) => reporteUso(trx, { desde: '2026-01-01', hasta: hoy }));
    expect(ajeno.filas).toEqual([]);
    await expect(e.owner.query(`DELETE FROM uso_ia WHERE empresa_id = $1`, [e.empresaA1])).rejects.toThrow(/no se modifican/u);
  });

  it('el costo del tramo superior de Haiku y el modelo fuera de la política se verifican en la base', async () => {
    const ctx = contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA2);
    const registrar = (modelo: string, entrada: number) =>
      enContexto(e.db, ctx, async (trx) => {
        // En la empresa A2 rige la política del Cliente ERP: todo con Haiku.
        const { rows: pol } = await sql<{ politica_id: string }>`SELECT politica_id FROM ia_politica_vigente(${e.empresaA2}::uuid, 'TESORERO')`.execute(trx);
        const { rows } = await sql<{ id: string }>`
          SELECT ia_registrar_uso(${e.empresaA2}::uuid, 'TESORERO', NULL, ${modelo}, ${pol[0]!.politica_id}::bigint, ${entrada}::int, 1000, true, NULL, 10) AS id`.execute(trx);
        return rows[0]!.id;
      });
    const id = await registrar('claude-haiku-5-5', 200_000);
    const fila = (await e.owner.query(`SELECT costo_usd::text FROM uso_ia WHERE id = $1`, [id])).rows[0] as { costo_usd: string };
    // 200.000 × 0,50 + 1.000 × 2,50 por millón = 0,1025 USD.
    expect(fila.costo_usd).toBe('0.102500');
    await expect(registrar('claude-opus-5-5', 1)).rejects.toThrow(/no corresponde a la política vigente/u);
    // El registro de uso no se puede vaciar.
    await expect(e.owner.query('TRUNCATE uso_ia')).rejects.toThrow(/no se modifican/u);
    await expect(e.owner.query('TRUNCATE politicas_ia CASCADE')).rejects.toThrow(/no se modifican/u);
  });

  it('con un plazo total vencido no se llama a ningún modelo', async () => {
    const m = new ModeloEnrutado(e.db, fabricaSimulada(), { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1, agenteCodigo: 'CONTADOR_GENERAL', plazoMs: 0 });
    await expect(m.responder({ instrucciones: 'x', mensajes: [], herramientas: [] })).rejects.toThrow(/demasiado tiempo/u);
    expect(m.intentos).toEqual([]);
  });
});

describe('Conversación por la API', () => {
  let app: FastifyInstance;
  const sesiones = new Map<string, Record<string, string>>();
  const ingresar = async (u: UsuarioPrueba) => {
    // El código de doble factor no se puede reutilizar: una sesión por persona.
    if (sesiones.has(u.id)) return sesiones.get(u.id)!;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
    const cookie = login.cookies.find((c) => c.name === NOMBRE_COOKIE)!.value;
    await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verificar',
      cookies: { [NOMBRE_COOKIE]: cookie },
      payload: { codigo: codigoParaPaso(base32Decodificar(u.totpSecreto!), pasoTotp(Date.now())) },
    });
    sesiones.set(u.id, { [NOMBRE_COOKIE]: cookie });
    return sesiones.get(u.id)!;
  };

  beforeAll(async () => {
    // El cupo de la prueba anterior quedó agotado: para conversar se permite seguir.
    await e.owner.query(`UPDATE cupos_ia SET al_exceder = 'CONTINUAR' WHERE cliente_erp_id = $1`, [e.clienteA]);
    const config = cargarConfiguracion({ NODE_ENV: 'test', DATABASE_URL: inject('urlApp'), DATABASE_URL_AUTH: inject('urlAuth'), CLAVE_MAESTRA_CIFRADO: CLAVE_PRUEBAS, LIMITE_LOGIN_POR_MINUTO: '1000' });
    app = await crearServidor({
      db: e.db,
      config,
      autenticacion: new ServicioAutenticacion(e.dbAuth, e.cifrador, config),
      registro: new RegistroAgentes(),
      fabricaModelos: fabricaSimulada(),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('conversa con el agente, guarda el historial y lo retoma; otra persona no puede retomarla', async () => {
    const c = await ingresar(e.usuarios.contadorA1);
    const url = `/api/empresas/${e.empresaA1}/agentes/ANALISTA_TRIBUTARIO/conversar`;
    const r1 = await app.inject({ method: 'POST', url, cookies: c, payload: { mensaje: '¿Cuánto IVA pago este mes?' } });
    expect(r1.statusCode).toBe(200);
    const { conversacionId, respuesta, modelos } = r1.json() as { conversacionId: string; respuesta: string; modelos: Array<{ modelo: string }> };
    expect(respuesta).toBe('Respuesta de claude-haiku-5-5');
    expect(modelos.map((x) => x.modelo)).toEqual(['claude-haiku-5-5']);
    const r2 = await app.inject({ method: 'POST', url, cookies: c, payload: { mensaje: '¿Y el mes anterior?', conversacionId } });
    expect(r2.statusCode).toBe(200);
    const ultima = recibido['claude-haiku-5-5']!.at(-1)!;
    expect(ultima.map((m) => (m.rol === 'usuario' || m.rol === 'asistente' ? m.texto : ''))).toEqual([
      '¿Cuánto IVA pago este mes?',
      'Respuesta de claude-haiku-5-5',
      '¿Y el mes anterior?',
    ]);
    const otro = await ingresar(e.usuarios.gerenteA1);
    const r3 = await app.inject({ method: 'POST', url, cookies: otro, payload: { mensaje: 'hola', conversacionId } });
    expect(r3.statusCode).toBe(404);
    const ajeno = await ingresar(e.usuarios.adminB);
    expect((await app.inject({ method: 'POST', url, cookies: ajeno, payload: { mensaje: 'hola' } })).statusCode).toBe(403);
    // Alguien sin permiso para ver trazas ajenas tampoco puede escribir en la conversación de otro.
    const colaborador = await ingresar(e.usuarios.colaboradorA1);
    expect((await app.inject({ method: 'POST', url, cookies: colaborador, payload: { mensaje: 'hola', conversacionId } })).statusCode).toBe(404);
    const { rows } = await e.owner.query(`SELECT count(*)::int AS n FROM trazas_agente WHERE conversacion_id = $1 AND usuario_id <> $2`, [conversacionId, e.usuarios.contadorA1.id]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('un mensaje con una contraseña o clave no se envía a ningún modelo ni se guarda', async () => {
    const c = await ingresar(e.usuarios.contadorA1);
    const antes = Object.values(recibido).reduce((s, l) => s + l.length, 0);
    const r = await app.inject({
      method: 'POST',
      url: `/api/empresas/${e.empresaA1}/agentes/GERENTE_VIRTUAL/conversar`,
      cookies: c,
      payload: { mensaje: 'mi clave SII es Secreta123, entra y descarga el RCV' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.codigo).toBe('CREDENCIALES_EN_MENSAJE');
    expect(Object.values(recibido).reduce((s, l) => s + l.length, 0)).toBe(antes);
    const { rows } = await e.owner.query(`SELECT count(*)::int AS n FROM trazas_agente WHERE contenido::text LIKE '%Secreta123%'`);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('limita las consultas simultáneas y por minuto de cada persona', () => {
    const liberar = [ocuparConsulta('u-limite', 'e-limite'), ocuparConsulta('u-limite', 'e-limite')];
    expect(() => ocuparConsulta('u-limite', 'e-limite')).toThrow(/en curso/u);
    liberar.forEach((f) => f());
    for (let i = 0; i < 8; i++) ocuparConsulta('u-limite', 'e-limite')();
    expect(() => ocuparConsulta('u-limite', 'e-limite')).toThrow(/Espere un minuto/u);
  });

  it('muestra los modelos, las políticas de cada agente y el uso', async () => {
    const c = await ingresar(e.usuarios.adminA);
    const modelos = await app.inject({ method: 'GET', url: '/api/ia/modelos', cookies: c });
    expect(modelos.json().find((m: { codigo: string }) => m.codigo === 'claude-haiku-5-5')).toMatchObject({ usd_por_millon_entrada: 0.1 });
    const pol = await app.inject({ method: 'GET', url: `/api/empresas/${e.empresaA1}/ia/politicas`, cookies: c });
    expect(pol.json().politicas.find((p: { agente: string }) => p.agente === 'CONTADOR_GENERAL')).toMatchObject({ nivel: 'EMPRESA', cadena: ['ollama-local', 'claude-opus-5-5'] });
    const uso = await app.inject({ method: 'GET', url: `/api/ia/uso?desde=2026-01-01&hasta=${new Date().toISOString().slice(0, 10)}`, cookies: c });
    expect(uso.statusCode).toBe(200);
    const cont = await ingresar(e.usuarios.contadorA1);
    expect((await app.inject({ method: 'GET', url: '/api/ia/uso?desde=2026-01-01&hasta=2026-12-31', cookies: cont })).statusCode).toBe(403);
    // Sin cupo nuevo no se puede saltar la validación de fechas.
    expect((await app.inject({ method: 'GET', url: '/api/ia/uso?desde=2026-02-30&hasta=2026-12-31', cookies: c })).statusCode).toBe(422);
    void sql;
  });
});
