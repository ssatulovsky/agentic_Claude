/**
 * Puente entre WhatsApp Web (librería Baileys, el conector existente) y el ERP.
 *
 *  - WhatsApp → ERP: texto y notas de voz de chats directos, firmados (POST /api/canales/whatsapp/mensajes).
 *  - ERP → WhatsApp: POST /enviar firmado, solo hacia destinos permitidos.
 *  - Latido al ERP cada minuto con el estado de la conexión.
 *
 * Nunca registra el contenido de los mensajes. La sesión de WhatsApp (equivalente a una
 * contraseña) vive en PUENTE_SESION_DIR, fuera del repositorio y solo legible por el dueño.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { cabecerasFirmadas, CABECERA_FIRMA, CABECERA_MARCA, firmaValida } from '../../src/canales/whatsapp/firma.js';
import { ColaSerial, leerConfiguracionVoz, limpiarTemporales, sintetizarNotaDeVoz } from './voz.js';
import { ConjuntoAcotado, decidir, destinoPermitido, jidDesdeTelefono, leerConfiguracion, MARCA_PUENTE, telefonoDesdeJid, usuarioDeJid, type MensajeEntranteWa } from './nucleo.js';

const config = leerConfiguracion(process.env);
const configVoz = leerConfiguracionVoz(process.env);
const colaVoz = new ColaSerial();
const log = (evento: string, datos: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), evento, ...datos }));

let sock: WASocket | null = null;
let conectado = false;
let propio: string | null = null;
let propioLid: string | null = null;
let reintentoConexion = 0;
/** Hasta cuándo (segundos Unix) está abierta la conversación del titular consigo mismo con el ERP. */
let sesionPropiaHasta = 0;
const enviados = new ConjuntoAcotado();
const recibidos = new ConjuntoAcotado();

// Logger silencioso para la librería: no debe volcar mensajes ni datos personales.
const silencioso: any = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => silencioso };

/** Envía al ERP con firma y reintentos (el ERP descarta duplicados por el id del mensaje). */
async function alErp(ruta: string, cuerpo: unknown, intentos = 5): Promise<void> {
  const texto = JSON.stringify(cuerpo);
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(`${config.erpUrl}${ruta}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cabecerasFirmadas(config.secreto, `POST ${ruta}`, texto) },
        body: texto,
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) return;
      if (r.status < 500 && r.status !== 429) {
        log('erp_rechazo', { ruta, estado: r.status });
        return;
      }
      log('erp_error', { ruta, estado: r.status, intento: i });
    } catch (e) {
      log('erp_inalcanzable', { ruta, intento: i, error: (e as Error).name });
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** i)));
  }
}

async function latido(): Promise<void> {
  await alErp('/api/canales/whatsapp/latido', { estado: conectado ? 'CONECTADO' : 'DESCONECTADO', ...(conectado ? {} : { detalle: 'Esperando conexión o código QR' }) }, 1);
}

async function enviarTexto(telefono: string, texto: string): Promise<void> {
  if (!sock || !conectado) throw new Error('WhatsApp no está conectado');
  const enviado = await sock.sendMessage(jidDesdeTelefono(telefono), { text: MARCA_PUENTE + texto });
  if (enviado?.key?.id) enviados.add(enviado.key.id);
}

/** Nota de voz con la respuesta (Piper + ffmpeg). Si falla, la respuesta ya llegó por escrito. */
function enviarVoz(telefono: string, texto: string): void {
  if (!configVoz) return;
  const tarea = colaVoz.agregar(async () => {
    if (!sock || !conectado) return;
    const nota = await sintetizarNotaDeVoz(configVoz, texto);
    if (!sock || !conectado) return;
    const enviado = await sock.sendMessage(jidDesdeTelefono(telefono), { audio: nota.audio, mimetype: nota.mimetype, ptt: true, seconds: nota.segundos });
    if (enviado?.key?.id) enviados.add(enviado.key.id);
    log('voz_enviada', { segundos: nota.segundos });
  });
  if (!tarea) {
    log('voz_descartada', { motivo: 'COLA_LLENA' });
    return;
  }
  void tarea
    .then((r) => {
      if (r === 'VENCIDA') log('voz_descartada', { motivo: 'ESPERA_EXCESIVA' });
    })
    .catch((e) => log('error_voz', { error: (e as Error).message }));
}

async function conectar(): Promise<void> {
  mkdirSync(config.sesionDir, { recursive: true, mode: 0o700 });
  chmodSync(config.sesionDir, 0o700);
  const { state, saveCreds } = await useMultiFileAuthState(config.sesionDir);
  // Versión del protocolo de WhatsApp Web: se consulta la vigente; si no responde o no tiene
  // la forma esperada, se usa la que trae la librería.
  const { version: vigente } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const version = Array.isArray(vigente) && vigente.length === 3 && vigente.every((n) => Number.isInteger(n) && n >= 0) ? vigente : undefined;
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: silencioso,
    browser: ['ERP Agentico', 'Chrome', '1.0'],
    // Privacidad: sin historial de chats, sin cambiar el estado "en línea" del titular.
    syncFullHistory: false,
    markOnlineOnConnect: false,
    shouldIgnoreJid: (jid: string) => !jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    try {
      if (qr) {
        log('qr', { instruccion: 'Escanee el código con WhatsApp > Dispositivos vinculados' });
        console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
        const archivo = join(config.sesionDir, 'qr.png');
        writeFileSync(archivo, await QRCode.toBuffer(qr, { width: 320 }), { mode: 0o600 });
      }
      if (connection === 'open') {
        conectado = true;
        reintentoConexion = 0;
        propio = telefonoDesdeJid(`${usuarioDeJid(sock?.user?.id)}@s.whatsapp.net`);
        propioLid = sock?.user?.lid ? usuarioDeJid(sock.user.lid) : null;
        log('conectado', { modo: config.modo });
        void latido();
      }
      if (connection === 'close') {
        conectado = false;
        void latido();
        const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (codigo === DisconnectReason.loggedOut) {
          log('sesion_cerrada', { instruccion: `Se cerró la sesión desde el teléfono. Borre ${config.sesionDir} y vuelva a iniciar el puente para escanear un QR nuevo.` });
          return;
        }
        if (codigo === DisconnectReason.connectionReplaced) {
          log('sesion_reemplazada', { instruccion: 'Otra instancia del puente (u otra sesión) tomó la conexión. Deje solo una y reinicie este puente.' });
          return;
        }
        reintentoConexion++;
        const espera = Math.min(60_000, 2000 * reintentoConexion);
        log('reconectando', { codigo, esperaMs: espera });
        setTimeout(() => void conectar().catch((e) => log('error_conexion', { error: (e as Error).message })), espera);
      }
    } catch (e) {
      log('error_estado_conexion', { error: (e as Error).message });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      const d = decidir(msg as MensajeEntranteWa, {
        propio,
        propioLid,
        modo: config.modo,
        permitidos: config.permitidos,
        enviados,
        ahoraS: Math.floor(Date.now() / 1000),
        edadMaximaS: config.edadMaximaS,
        audioMaxBytes: config.audioMaxBytes,
        prefijo: config.prefijo,
        sesionPropiaHasta,
      });
      if (d.sesion === 'ABRIR') sesionPropiaHasta = Math.floor(Date.now() / 1000) + config.ventanaS;
      if (d.sesion === 'CERRAR') {
        sesionPropiaHasta = 0;
        if (propio) await enviarTexto(propio, `Conversación con el ERP cerrada. Escriba «${config.prefijo}» y su consulta para volver.`).catch(() => undefined);
      }
      if (!d.reenviar) continue;
      if (recibidos.has(d.id)) continue;
      recibidos.add(d.id);
      try {
        if (d.contenido.tipo === 'TEXTO') {
          await alErp('/api/canales/whatsapp/mensajes', { id: d.id, de: d.de, tipo: 'TEXTO', texto: d.contenido.texto });
        } else {
          const audio = await descargarAcotado(msg, config.audioMaxBytes);
          if (!audio) {
            log('audio_grande', { id: d.id });
            continue;
          }
          await alErp('/api/canales/whatsapp/mensajes', { id: d.id, de: d.de, tipo: 'AUDIO', audio: { base64: audio.toString('base64'), mime: d.contenido.mime } });
        }
        log('reenviado', { id: d.id, tipo: d.contenido.tipo });
      } catch (e) {
        log('error_reenvio', { id: d.id, error: (e as Error).message });
      }
    }
  });
}

/** Descarga una nota de voz contando bytes: corta apenas supera el máximo (no confía en el largo declarado). */
async function descargarAcotado(msg: unknown, maximo: number): Promise<Buffer | null> {
  const flujo = (await downloadMediaMessage(msg as Parameters<typeof downloadMediaMessage>[0], 'stream', {}, {
    logger: silencioso,
    reuploadRequest: sock!.updateMediaMessage,
  })) as AsyncIterable<Buffer> & { destroy(): void };
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of flujo) {
    total += parte.length;
    if (total > maximo) {
      flujo.destroy();
      return null;
    }
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
  ) {
    super(codigo);
  }
}

/** Servidor local para que el ERP envíe respuestas: POST /enviar firmado. */
function leerCuerpo(req: IncomingMessage, maximo: number): Promise<string> {
  return new Promise((resolver, rechazar) => {
    let total = 0;
    const partes: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maximo) {
        rechazar(new ErrorHttp(413, 'DEMASIADO_GRANDE'));
        req.destroy();
      } else partes.push(c);
    });
    req.on('end', () => resolver(Buffer.concat(partes).toString('utf8')));
    req.on('error', rechazar);
  });
}

function responder(res: ServerResponse, estado: number, cuerpo: unknown) {
  res.writeHead(estado, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/salud') return responder(res, 200, { conectado, modo: config.modo, voz: configVoz !== null });
    if (req.method !== 'POST' || req.url !== '/enviar') return responder(res, 404, { error: 'NO_ENCONTRADO' });
    const cuerpo = await leerCuerpo(req, 64 * 1024);
    const marca = req.headers[CABECERA_MARCA];
    const firma = req.headers[CABECERA_FIRMA];
    if (!firmaValida(config.secreto, typeof marca === 'string' ? marca : undefined, typeof firma === 'string' ? firma : undefined, 'POST /enviar', cuerpo)) {
      return responder(res, 401, { error: 'FIRMA_INVALIDA' });
    }
    let d: { para?: unknown; texto?: unknown; voz?: unknown };
    try {
      d = JSON.parse(cuerpo) as { para?: unknown; texto?: unknown; voz?: unknown };
    } catch {
      return responder(res, 400, { error: 'JSON_INVALIDO' });
    }
    if (typeof d.para !== 'string' || typeof d.texto !== 'string' || !d.texto || d.texto.length > 4096) return responder(res, 422, { error: 'DATOS_INVALIDOS' });
    if (d.voz !== undefined && (typeof d.voz !== 'string' || !d.voz.trim() || d.voz.length > 1500)) return responder(res, 422, { error: 'DATOS_INVALIDOS' });
    if (!destinoPermitido(d.para, { propio, modo: config.modo, permitidos: config.permitidos })) return responder(res, 403, { error: 'DESTINO_NO_PERMITIDO' });
    if (!conectado) return responder(res, 503, { error: 'DESCONECTADO' });
    await enviarTexto(d.para, d.texto);
    // La voz se genera después de responder: el texto ya llegó y el ERP no espera la síntesis.
    if (typeof d.voz === 'string') enviarVoz(d.para, d.voz);
    return responder(res, 200, { enviado: true, voz: typeof d.voz === 'string' && configVoz !== null });
  } catch (e) {
    if (e instanceof ErrorHttp) {
      if (!res.headersSent) responder(res, e.estado, { error: e.codigo });
      return;
    }
    log('error_envio', { error: (e as Error).message });
    if (!res.headersSent) responder(res, 500, { error: 'ERROR' });
  }
}).listen(config.puerto, config.host, () => log('escuchando', { host: config.host, puerto: config.puerto }));

setInterval(() => void latido(), 60_000).unref();
if (configVoz) void limpiarTemporales().then((n) => n && log('temporales_borrados', { carpetas: n }));
void conectar().catch((e) => {
  log('error_conexion', { error: (e as Error).message });
  process.exitCode = 1;
});
