import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { ejecutarHerramienta } from '../src/agentes/ejecutor.js';
import type { DefinicionHerramienta, MensajeConversacion, ModeloIA, RespuestaModelo } from '../src/agentes/tipos.js';
import { crearServidor, NOMBRE_COOKIE } from '../src/api/servidor.js';
import { cabecerasFirmadas, firmaValida } from '../src/canales/whatsapp/firma.js';
import { partirTexto, PuenteHttp, type CanalMensajeria } from '../src/canales/whatsapp/puente.js';
import { TranscriptorCompatible, type Transcriptor } from '../src/canales/whatsapp/transcripcion.js';
import { cargarConfiguracion } from '../src/config.js';
import type { FabricaModelos } from '../src/ia/enrutador.js';
import { ServicioAutenticacion } from '../src/seguridad/autenticacion.js';
import { base32Decodificar, codigoParaPaso, pasoTotp } from '../src/seguridad/totp.js';
import { CLAVE_PRUEBAS } from './preparacionGlobal.js';
import { CONTRASENA, crearEscenario, type Escenario, type UsuarioPrueba } from './escenario.js';

const SECRETO = 'secreto-del-puente-de-pruebas-0123456789';
const TEL_CONTADOR = '+56911111111';
const TEL_GERENTE = '+56922222222';
const TEL_DESCONOCIDO = '+56999999999';

let e: Escenario;
let app: FastifyInstance;
const enviados: Array<{ para: string; texto: string }> = [];
const alModelo: MensajeConversacion[][] = [];
let transcripcion = 'cuál es el saldo del banco';

const canal: CanalMensajeria = {
  async enviar(para, texto) {
    enviados.push({ para, texto });
  },
};
const transcriptor: Transcriptor = {
  async transcribir() {
    return transcripcion;
  },
};
const fabrica: FabricaModelos = (): ModeloIA => ({
  async responder(p): Promise<RespuestaModelo> {
    alModelo.push([...p.mensajes]);
    const ultimo = p.mensajes.at(-1);
    return { tipo: 'texto', texto: `Respuesta a: ${ultimo && 'texto' in ultimo ? ultimo.texto : ''}`, uso: { tokensEntrada: 10, tokensSalida: 5 } };
  },
});

const sesiones = new Map<string, Record<string, string>>();
async function ingresar(u: UsuarioPrueba) {
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
}

let contador = 0;
/** Envía un mensaje firmado como lo haría el puente y espera a que el ERP responda. */
async function recibir(de: string, cuerpo: Record<string, unknown>, opciones: { id?: string; secreto?: string; marca?: number; destino?: string } = {}) {
  const payload = JSON.stringify({ id: opciones.id ?? `msg-${++contador}`, de, ...cuerpo });
  const r = await app.inject({
    method: 'POST',
    url: '/api/canales/whatsapp/mensajes',
    headers: { 'content-type': 'application/json', ...cabecerasFirmadas(opciones.secreto ?? SECRETO, opciones.destino ?? 'POST /api/canales/whatsapp/mensajes', payload, opciones.marca) },
    payload,
  });
  await app.canalWhatsapp!.esperarPendientes();
  return r;
}
const escribir = (de: string, texto: string, id?: string) => recibir(de, { tipo: 'TEXTO', texto }, id ? { id } : {});
const ultimaRespuesta = (para: string) => enviados.filter((x) => x.para === para).at(-1)?.texto ?? '';

beforeAll(async () => {
  e = await crearEscenario();
  await e.owner.query(`UPDATE usuarios SET telefono_whatsapp = $2 WHERE id = $1`, [e.usuarios.contadorA1.id, TEL_CONTADOR]);
  await e.owner.query(`UPDATE usuarios SET telefono_whatsapp = $2 WHERE id = $1`, [e.usuarios.gerenteA1.id, TEL_GERENTE]);
  await e.owner.query(`INSERT INTO cupos_ia (cliente_erp_id, vigente_desde, usd_mensual, al_exceder) VALUES ($1, '2026-01-01', 1000, 'CONTINUAR')`, [e.clienteA]);
  const config = cargarConfiguracion({
    NODE_ENV: 'test',
    DATABASE_URL: inject('urlApp'),
    DATABASE_URL_AUTH: inject('urlAuth'),
    CLAVE_MAESTRA_CIFRADO: CLAVE_PRUEBAS,
    LIMITE_LOGIN_POR_MINUTO: '1000',
    WHATSAPP_PUENTE_SECRETO: SECRETO,
    WHATSAPP_NUMERO: '+56900000000',
  });
  app = await crearServidor({
    db: e.db,
    dbAuth: e.dbAuth,
    config,
    autenticacion: new ServicioAutenticacion(e.dbAuth, e.cifrador, config),
    registro: new RegistroAgentes(),
    fabricaModelos: fabrica,
    canalWhatsapp: canal,
    transcriptor,
  });
});
afterAll(async () => {
  await app.close();
  await e.cerrar();
});

describe('Puente firmado', () => {
  it('verifica la firma HMAC y rechaza firmas ajenas o antiguas', async () => {
    const cuerpo = '{"a":1}';
    const h = cabecerasFirmadas(SECRETO, 'POST /x', cuerpo);
    expect(firmaValida(SECRETO, h['x-erp-marca-tiempo'], h['x-erp-firma'], 'POST /x', cuerpo)).toBe(true);
    expect(firmaValida(SECRETO, h['x-erp-marca-tiempo'], h['x-erp-firma'], 'POST /x', '{"a":2}')).toBe(false);
    // Una firma de un sentido (ERP → puente) no sirve en el otro.
    expect(firmaValida(SECRETO, h['x-erp-marca-tiempo'], h['x-erp-firma'], 'POST /y', cuerpo)).toBe(false);
    expect((await recibir(TEL_DESCONOCIDO, { tipo: 'TEXTO', texto: 'hola' }, { destino: 'POST /enviar' })).statusCode).toBe(401);
    expect((await recibir(TEL_DESCONOCIDO, { tipo: 'TEXTO', texto: 'hola' }, { secreto: 'otro-secreto-que-no-es-el-del-puente!!' })).statusCode).toBe(401);
    expect((await recibir(TEL_DESCONOCIDO, { tipo: 'TEXTO', texto: 'hola' }, { marca: Date.now() - 10 * 60_000 })).statusCode).toBe(401);
    const sinFirma = await app.inject({ method: 'POST', url: '/api/canales/whatsapp/mensajes', payload: { id: 'x', de: TEL_DESCONOCIDO, tipo: 'TEXTO', texto: 'hola' } });
    expect(sinFirma.statusCode).toBe(401);
    expect(enviados).toEqual([]);
  });

  it('un cuerpo grande sin firma se rechaza antes de leerlo, y el latido acepta solo cuerpos pequeños', async () => {
    const grande = await app.inject({
      method: 'POST',
      url: '/api/canales/whatsapp/mensajes',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ relleno: 'x'.repeat(2_000_000) }),
    });
    expect(grande.statusCode).toBe(401);
    const payload = JSON.stringify({ estado: 'CONECTADO', detalle: 'x'.repeat(5000) });
    const latido = await app.inject({
      method: 'POST',
      url: '/api/canales/whatsapp/latido',
      headers: { 'content-type': 'application/json', ...cabecerasFirmadas(SECRETO, 'POST /api/canales/whatsapp/latido', payload) },
      payload,
    });
    expect(latido.statusCode).toBe(413);
  });

  it('la transcripción debe ser local salvo autorización expresa', () => {
    const base = { DATABASE_URL: 'postgres://a@b/c', DATABASE_URL_AUTH: 'postgres://a@b/c', CLAVE_MAESTRA_CIFRADO: CLAVE_PRUEBAS };
    expect(() => cargarConfiguracion({ ...base, TRANSCRIPCION_URL: 'https://api.ejemplo.com' })).toThrow(/servicio externo/u);
    expect(cargarConfiguracion({ ...base, TRANSCRIPCION_URL: 'https://api.ejemplo.com', TRANSCRIPCION_EXTERNA_AUTORIZADA: 'true' }).TRANSCRIPCION_URL).toBeDefined();
    expect(cargarConfiguracion({ ...base, TRANSCRIPCION_URL: 'http://whisper:8000' }).TRANSCRIPCION_URL).toBeDefined();
  });

  it('el envío al puente va firmado y los textos largos se parten', async () => {
    const llamadas: Array<{ url: string; cuerpo: string; firma: string; marca: string }> = [];
    const puente = new PuenteHttp({
      url: 'http://puente.local/',
      secreto: SECRETO,
      fetch: (async (url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        llamadas.push({ url, cuerpo: init.body as string, firma: h['x-erp-firma']!, marca: h['x-erp-marca-tiempo']! });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await puente.enviar(TEL_CONTADOR, `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`);
    expect(llamadas.map((l) => l.url)).toEqual(['http://puente.local/enviar', 'http://puente.local/enviar']);
    expect(llamadas.every((l) => firmaValida(SECRETO, l.marca, l.firma, 'POST /enviar', l.cuerpo))).toBe(true);
    expect(partirTexto('x'.repeat(9000)).map((p) => p.length)).toEqual([4000, 4000, 1000]);
  });

  it('el transcriptor usa la API compatible con Whisper', async () => {
    let recibido: FormData | null = null;
    const t = new TranscriptorCompatible({
      url: 'http://whisper.local',
      modelo: 'whisper-1',
      fetch: (async (_url: string, init: RequestInit) => {
        recibido = init.body as FormData;
        return new Response(JSON.stringify({ text: ' hola ' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await t.transcribir(Buffer.from('OggS'), 'audio/ogg; codecs=opus')).toBe('hola');
    expect((recibido as unknown as FormData).get('language')).toBe('es');
  });
});

describe('Vinculación del teléfono', () => {
  it('un número no vinculado recibe un solo aviso por hora y nada llega a los agentes', async () => {
    await escribir(TEL_DESCONOCIDO, '¿Cuánto IVA pago?');
    await escribir(TEL_DESCONOCIDO, '¿Hola?');
    const aDesconocido = enviados.filter((x) => x.para === TEL_DESCONOCIDO);
    expect(aDesconocido).toHaveLength(1);
    expect(aDesconocido[0]!.texto).toMatch(/no está vinculado/u);
    expect(alModelo).toEqual([]);
  });

  it('se vincula con el código de la web enviado desde el teléfono registrado', async () => {
    const c = await ingresar(e.usuarios.contadorA1);
    const inicio = await app.inject({ method: 'POST', url: '/api/yo/whatsapp/vincular', cookies: c, headers: { 'x-erp-solicitud': '1' } });
    expect(inicio.statusCode).toBe(200);
    const { codigo, instruccion } = inicio.json() as { codigo: string; instruccion: string };
    expect(instruccion).toBe(`Desde ${TEL_CONTADOR}, envíe por WhatsApp el mensaje: VINCULAR ${codigo}`);
    // El código desde otro teléfono no sirve; un código errado cuenta como intento.
    await escribir(TEL_GERENTE, `VINCULAR ${codigo}`);
    expect(ultimaRespuesta(TEL_GERENTE)).toMatch(/No hay una vinculación pendiente/u);
    const errado = codigo === '000000' ? '111111' : '000000';
    await escribir(TEL_CONTADOR, `VINCULAR ${errado}`);
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/no es correcto/u);
    await escribir(TEL_CONTADOR, `vincular ${codigo}`);
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/quedó vinculado/u);
    const estado = await app.inject({ method: 'GET', url: '/api/yo/whatsapp', cookies: c });
    expect(estado.json()).toMatchObject({ canalConfigurado: true, numeroErp: '+56900000000', vinculo: { telefono: TEL_CONTADOR, estado: 'VERIFICADO' } });
    const { rows } = await e.owner.query(`SELECT accion FROM bitacora WHERE accion LIKE 'WHATSAPP_%' ORDER BY id`);
    expect(rows.map((r: { accion: string }) => r.accion)).toEqual(['WHATSAPP_VINCULACION_INICIADA', 'WHATSAPP_VINCULADO']);
  });

  it('los intentos de vinculación fallidos reciben a lo más tres respuestas por hora', async () => {
    const tel = '+56988888888';
    for (let i = 0; i < 4; i++) await escribir(tel, 'VINCULAR 000000');
    expect(enviados.filter((x) => x.para === tel)).toHaveLength(3);
  });

  it('el código vence tras cinco intentos fallidos', async () => {
    const c = await ingresar(e.usuarios.gerenteA1);
    const { codigo } = (await app.inject({ method: 'POST', url: '/api/yo/whatsapp/vincular', cookies: c, headers: { 'x-erp-solicitud': '1' } })).json() as { codigo: string };
    const errado = codigo === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await escribir(TEL_GERENTE, `VINCULAR ${errado}`);
    await escribir(TEL_GERENTE, `VINCULAR ${codigo}`, 'gerente-correcto');
    // (Las respuestas a intentos fallidos se limitan; el resultado queda registrado.)
    const { rows } = await e.owner.query(`SELECT detalle FROM mensajes_whatsapp WHERE id_externo = 'gerente-correcto'`);
    expect(rows[0]).toEqual({ detalle: 'VINCULAR:CODIGO_VENCIDO' });
    expect((await app.inject({ method: 'GET', url: '/api/yo/whatsapp', cookies: c })).json().vinculo.estado).toBe('PENDIENTE');
  });
});

describe('Conversación por WhatsApp', () => {
  it('pide elegir empresa, conversa con el agente y retoma el historial', async () => {
    await escribir(TEL_CONTADOR, '¿Cómo está el banco?');
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/Primero elija con qué empresa/u);
    await escribir(TEL_CONTADOR, 'empresas');
    const lista = ultimaRespuesta(TEL_CONTADOR);
    const n = lista.split('\n').findIndex((l) => l.includes('A1')) ;
    expect(n).toBeGreaterThan(0);
    await escribir(TEL_CONTADOR, `Empresa ${n}`);
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/Empresa elegida/u);
    await escribir(TEL_CONTADOR, 'agente tesorero');
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/Ahora conversa con \*Tesorero/u);
    await escribir(TEL_CONTADOR, '¿Cuál es el saldo del banco?');
    expect(ultimaRespuesta(TEL_CONTADOR)).toBe('Respuesta a: ¿Cuál es el saldo del banco?');
    await escribir(TEL_CONTADOR, '¿Y el mes pasado?');
    expect(alModelo.at(-1)!.map((m) => ('texto' in m ? m.texto : ''))).toEqual([
      '¿Cuál es el saldo del banco?',
      'Respuesta a: ¿Cuál es el saldo del banco?',
      '¿Y el mes pasado?',
    ]);
    const { rows } = await e.owner.query(
      `SELECT DISTINCT agente_codigo, empresa_id, usuario_id FROM trazas_agente WHERE contenido ->> 'texto' = '¿Y el mes pasado?'`,
    );
    expect(rows).toEqual([{ agente_codigo: 'TESORERO', empresa_id: e.empresaA1, usuario_id: e.usuarios.contadorA1.id }]);
    await escribir(TEL_CONTADOR, 'nueva');
    await escribir(TEL_CONTADOR, 'Otra pregunta');
    expect(alModelo.at(-1)).toHaveLength(1);
  });

  it('un mensaje repetido por el conector se procesa una sola vez', async () => {
    const antes = enviados.length;
    const r1 = await escribir(TEL_CONTADOR, 'ayuda', 'repetido-1');
    const r2 = await escribir(TEL_CONTADOR, 'ayuda', 'repetido-1');
    expect([r1.json(), r2.json()]).toEqual([{ aceptado: true }, { aceptado: false, motivo: 'DUPLICADO' }]);
    expect(enviados.length).toBe(antes + 1);
  });

  it('las claves no llegan al modelo ni se guardan, tampoco dictadas en una nota de voz', async () => {
    const antes = alModelo.length;
    await escribir(TEL_CONTADOR, 'mi clave SII es Secreta123, descarga el RCV');
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/no lo procesé/u);
    transcripcion = 'mi contraseña es Secreta456';
    await recibir(TEL_CONTADOR, { tipo: 'AUDIO', audio: { base64: Buffer.from('OggS').toString('base64'), mime: 'audio/ogg; codecs=opus' } });
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/no lo procesé/u);
    expect(ultimaRespuesta(TEL_CONTADOR)).not.toContain('Secreta456');
    expect(alModelo.length).toBe(antes);
    const { rows } = await e.owner.query(`SELECT count(*)::int AS n FROM trazas_agente WHERE contenido::text ~ 'Secreta(123|456)'`);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('una nota de voz se transcribe, se confirma lo entendido y se responde', async () => {
    transcripcion = 'cuál es el saldo del banco';
    await recibir(TEL_CONTADOR, { tipo: 'AUDIO', audio: { base64: Buffer.from('OggS').toString('base64'), mime: 'audio/ogg; codecs=opus' } });
    expect(ultimaRespuesta(TEL_CONTADOR)).toBe('🎙️ Entendí: «cuál es el saldo del banco»\n\nRespuesta a: cuál es el saldo del banco');
    await recibir(TEL_CONTADOR, { tipo: 'AUDIO', audio: { base64: Buffer.from('x').toString('base64'), mime: 'video/mp4' } });
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/No pude leer ese audio/u);
  });

  it('un mensaje que quedó a medias (reinicio del servidor) se reprocesa cuando el conector lo reenvía', async () => {
    await e.owner.query(
      `INSERT INTO mensajes_whatsapp (id_externo, telefono, tipo, recibido_en) VALUES ('atascado-1', $1, 'TEXTO', now() - interval '20 minutes')`,
      [TEL_CONTADOR],
    );
    const r = await escribir(TEL_CONTADOR, 'ayuda', 'atascado-1');
    expect(r.json()).toEqual({ aceptado: true });
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/Comandos/u);
    // Uno reciente (todavía en proceso) no se duplica.
    await e.owner.query(`INSERT INTO mensajes_whatsapp (id_externo, telefono, tipo) VALUES ('en-proceso-1', $1, 'TEXTO')`, [TEL_CONTADOR]);
    expect((await escribir(TEL_CONTADOR, 'ayuda', 'en-proceso-1')).json()).toEqual({ aceptado: false, motivo: 'DUPLICADO' });
  });

  it('los grupos no se atienden', async () => {
    const antes = enviados.length;
    const r = await recibir(TEL_CONTADOR, { tipo: 'TEXTO', texto: 'hola grupo', esGrupo: true });
    expect(r.json()).toEqual({ aceptado: false, motivo: 'GRUPO' });
    expect(enviados.length).toBe(antes);
  });

  it('si cambia el teléfono de la cuenta, el vínculo se revoca', async () => {
    await e.owner.query(`UPDATE usuarios SET telefono_whatsapp = '+56933333333' WHERE id = $1`, [e.usuarios.contadorA1.id]);
    await escribir(TEL_CONTADOR, '¿Cuál es el saldo?');
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/no está vinculado/u);
    await e.owner.query(`UPDATE usuarios SET telefono_whatsapp = $2 WHERE id = $1`, [e.usuarios.contadorA1.id, TEL_CONTADOR]);
  });

  it('desvincular desde el chat', async () => {
    const c = await ingresar(e.usuarios.contadorA1);
    const { codigo } = (await app.inject({ method: 'POST', url: '/api/yo/whatsapp/vincular', cookies: c, headers: { 'x-erp-solicitud': '1' } })).json() as { codigo: string };
    await escribir(TEL_CONTADOR, `VINCULAR ${codigo}`);
    await escribir(TEL_CONTADOR, 'desvincular');
    expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/quedó desvinculado/u);
    const estado = await app.inject({ method: 'GET', url: '/api/yo/whatsapp', cookies: c });
    expect(estado.json().vinculo.estado).toBe('REVOCADO');
  });

  it('un cambio de contraseña o de doble factor revoca el vínculo', async () => {
    const c = await ingresar(e.usuarios.contadorA1);
    const vincular = async () => {
      const { codigo } = (await app.inject({ method: 'POST', url: '/api/yo/whatsapp/vincular', cookies: c, headers: { 'x-erp-solicitud': '1' } })).json() as { codigo: string };
      await escribir(TEL_CONTADOR, `VINCULAR ${codigo}`);
      expect(ultimaRespuesta(TEL_CONTADOR)).toMatch(/quedó vinculado/u);
    };
    const estado = async () => (await app.inject({ method: 'GET', url: '/api/yo/whatsapp', cookies: c })).json().vinculo.estado as string;
    await vincular();
    await e.owner.query(`UPDATE usuarios SET password_hash = '$argon2id$otro' WHERE id = $1`, [e.usuarios.contadorA1.id]);
    expect(await estado()).toBe('REVOCADO');
  });
});

describe('Acciones y estado del canal', () => {
  it('por WhatsApp una acción con aviso queda como propuesta para aprobar en la web', async () => {
    const herramienta: DefinicionHerramienta<{ nota: string }, unknown> = {
      nombre: 'anotar_prueba',
      descripcion: 'Anota algo (prueba)',
      modulo: null,
      permiso: 'agentes.consultar',
      autonomia: 'EJECUTAR_CON_AVISO',
      entrada: z.object({ nota: z.string() }),
      async ejecutar(_c, entrada) {
        return { anotado: entrada.nota };
      },
    };
    const registro = new RegistroAgentes([herramienta as DefinicionHerramienta], [
      { codigo: 'AGENTE_PRUEBA', cargo: 'Prueba', descripcion: 'Prueba', instrucciones: 'x', herramientas: ['anotar_prueba'] },
    ]);
    await e.owner.query(`INSERT INTO agentes_config_empresa (empresa_id, agente_codigo, autonomia_maxima) VALUES ($1, 'AGENTE_PRUEBA', 'EJECUTAR_CON_AVISO')`, [e.empresaA1]);
    const usar = (canal: 'WEB' | 'WHATSAPP') =>
      ejecutarHerramienta(e.db, registro, {
        agenteCodigo: 'AGENTE_PRUEBA',
        solicitante: { usuarioId: e.usuarios.contadorA1.id, empresaId: e.empresaA1, canal },
        nombre: 'anotar_prueba',
        entrada: { nota: 'x' },
        fecha: '2026-10-30',
      });
    expect((await usar('WEB')).estado).toBe('EJECUTADA');
    expect((await usar('WHATSAPP')).estado).toBe('PROPUESTA_CREADA');
  });

  it('el latido del conector informa el estado; sin latidos se da por caído', async () => {
    const latido = (estado: string) => {
      const payload = JSON.stringify({ estado, detalle: 'prueba' });
      return app.inject({
        method: 'POST',
        url: '/api/canales/whatsapp/latido',
        headers: { 'content-type': 'application/json', ...cabecerasFirmadas(SECRETO, 'POST /api/canales/whatsapp/latido', payload) },
        payload,
      });
    };
    expect((await latido('CONECTADO')).statusCode).toBe(200);
    const admin = await ingresar(e.usuarios.adminA);
    // El detalle técnico del conector no se muestra a los clientes.
    expect((await app.inject({ method: 'GET', url: '/api/canales/whatsapp/estado', cookies: admin })).json()).toMatchObject({ configurado: true, estado: 'CONECTADO', detalle: null });
    expect((await app.inject({ method: 'GET', url: '/api/canales/whatsapp/estado', cookies: await ingresar(e.usuarios.contadorA1) })).statusCode).toBe(403);
    await e.owner.query(`UPDATE estado_canal_whatsapp SET ultimo_latido = now() - interval '5 minutes'`);
    expect((await app.inject({ method: 'GET', url: '/api/canales/whatsapp/estado', cookies: admin })).json()).toMatchObject({ estado: 'DESCONECTADO' });
    await e.owner.query(`INSERT INTO mensajes_whatsapp (id_externo, telefono, tipo, recibido_en) VALUES ('viejo-1', '+56977777777', 'TEXTO', now() - interval '40 days')`);
    await latido('CONECTADO');
    // Retención: los metadatos de números desconocidos se borran a los 30 días.
    expect((await e.owner.query(`SELECT count(*)::int AS n FROM mensajes_whatsapp WHERE id_externo = 'viejo-1'`)).rows[0]).toEqual({ n: 0 });
    const { rows } = await e.owner.query(`SELECT accion FROM bitacora WHERE accion IN ('WHATSAPP_CONECTADO', 'WHATSAPP_DESCONECTADO') ORDER BY id`);
    // Primera conexión y reconexión tras la caída.
    expect(rows.map((r: { accion: string }) => r.accion)).toEqual(['WHATSAPP_CONECTADO', 'WHATSAPP_CONECTADO']);
  });
});
