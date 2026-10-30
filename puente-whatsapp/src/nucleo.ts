/**
 * Lógica pura del puente de WhatsApp (sin la librería de WhatsApp), para poder probarla:
 * de qué teléfono viene un mensaje, qué contiene, y si se reenvía al ERP o se ignora.
 */

/** Marca invisible al inicio de cada texto que envía el puente: evita que se responda a sí mismo. */
export const MARCA_PUENTE = '⁣';

export type Modo = 'PERSONAL' | 'DEDICADO';

export interface ConfiguracionPuente {
  erpUrl: string;
  secreto: string;
  puerto: number;
  host: string;
  sesionDir: string;
  modo: Modo;
  /** Teléfonos (además del propio) cuyos mensajes se reenvían en modo PERSONAL. */
  permitidos: Set<string>;
  audioMaxBytes: number;
  /** Mensajes más antiguos que esto (segundos) se ignoran: historial o sincronización. */
  edadMaximaS: number;
}

export function leerConfiguracion(entorno: NodeJS.ProcessEnv): ConfiguracionPuente {
  const secreto = entorno.PUENTE_SECRETO ?? entorno.WHATSAPP_PUENTE_SECRETO ?? '';
  if (secreto.length < 32) throw new Error('PUENTE_SECRETO debe tener al menos 32 caracteres (el mismo WHATSAPP_PUENTE_SECRETO del ERP).');
  const modo = (entorno.PUENTE_MODO ?? 'PERSONAL').toUpperCase();
  if (modo !== 'PERSONAL' && modo !== 'DEDICADO') throw new Error('PUENTE_MODO debe ser PERSONAL o DEDICADO.');
  const permitidos = new Set(
    (entorno.PUENTE_NUMEROS_PERMITIDOS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        if (!TELEFONO.test(x)) throw new Error(`Teléfono permitido inválido: ${x} (use +569XXXXXXXX)`);
        return x;
      }),
  );
  const erpUrl = (entorno.ERP_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
  const home = entorno.HOME ?? '.';
  return {
    erpUrl,
    secreto,
    puerto: Number(entorno.PUENTE_PUERTO ?? 3100),
    host: entorno.PUENTE_HOST ?? '127.0.0.1',
    sesionDir: entorno.PUENTE_SESION_DIR ?? `${home}/.erp-puente-whatsapp`,
    modo,
    permitidos,
    audioMaxBytes: Number(entorno.PUENTE_AUDIO_MAX_BYTES ?? 8 * 1024 * 1024),
    edadMaximaS: Number(entorno.PUENTE_EDAD_MAXIMA_S ?? 300),
  };
}

export const TELEFONO = /^\+[1-9]\d{7,14}$/u;

/** Parte de usuario de un JID: "56912345678:3@s.whatsapp.net" → "56912345678". */
export function usuarioDeJid(jid: string | null | undefined): string {
  return (jid ?? '').split('@')[0]!.split(':')[0]!;
}

/** Teléfono internacional desde un JID de teléfono (no de LID ni grupo); null si no lo es. */
export function telefonoDesdeJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const tel = `+${usuarioDeJid(jid)}`;
  return TELEFONO.test(tel) ? tel : null;
}

export function jidDesdeTelefono(telefono: string): string {
  return `${telefono.slice(1)}@s.whatsapp.net`;
}

export function esChatNoDirecto(jid: string): boolean {
  return jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast';
}

/** Lo mínimo de un mensaje de la librería que usa el puente. */
export interface MensajeEntranteWa {
  key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; senderPn?: string | null; participant?: string | null; [k: string]: unknown };
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | string | { toNumber(): number } | null;
}

export type Contenido = { tipo: 'TEXTO'; texto: string } | { tipo: 'AUDIO'; mime: string; bytes: number | null };

/** Texto o nota de voz de un mensaje (desenvuelve efímeros y "ver una vez"). */
export function extraerContenido(message: Record<string, unknown> | null | undefined): Contenido | null {
  if (!message) return null;
  const m = message as Record<string, any>;
  const interno =
    m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m;
  if (interno.audioMessage) {
    const largo = interno.audioMessage.fileLength;
    const bytes = largo == null ? null : Number(typeof largo === 'object' && 'toNumber' in largo ? largo.toNumber() : largo);
    return { tipo: 'AUDIO', mime: String(interno.audioMessage.mimetype ?? 'audio/ogg; codecs=opus'), bytes: Number.isFinite(bytes) ? bytes : null };
  }
  const texto = (interno.conversation ?? interno.extendedTextMessage?.text ?? '') as string;
  return texto.trim() ? { tipo: 'TEXTO', texto: texto.trim() } : null;
}

function marcaDeTiempo(v: MensajeEntranteWa['messageTimestamp']): number {
  if (v == null) return 0;
  if (typeof v === 'object') return v.toNumber();
  return Number(v);
}

export type Decision =
  | { reenviar: true; id: string; de: string; contenido: Contenido; chat: string }
  | { reenviar: false; motivo: string };

/**
 * Decide si un mensaje se reenvía al ERP. En modo PERSONAL (número de una persona usado
 * para pruebas) solo pasan el chat consigo mismo ("Tú") y los números permitidos: los
 * contactos personales nunca llegan al ERP ni reciben respuestas.
 */
export function decidir(
  msg: MensajeEntranteWa,
  ctx: { propio: string | null; propioLid: string | null; modo: Modo; permitidos: Set<string>; enviados: { has(id: string): boolean }; ahoraS: number; edadMaximaS: number; audioMaxBytes: number },
): Decision {
  const id = msg.key.id ?? '';
  const chat = msg.key.remoteJid ?? '';
  if (!id || !chat) return { reenviar: false, motivo: 'SIN_ID' };
  if (esChatNoDirecto(chat)) return { reenviar: false, motivo: 'NO_DIRECTO' };
  if (ctx.enviados.has(id)) return { reenviar: false, motivo: 'PROPIO' };
  const contenido = extraerContenido(msg.message);
  if (!contenido) return { reenviar: false, motivo: 'SIN_CONTENIDO' };
  if (contenido.tipo === 'TEXTO' && contenido.texto.startsWith(MARCA_PUENTE)) return { reenviar: false, motivo: 'PROPIO' };
  const ts = marcaDeTiempo(msg.messageTimestamp);
  if (!ts || ctx.ahoraS - ts > ctx.edadMaximaS) return { reenviar: false, motivo: 'ANTIGUO' };

  const usuarioChat = usuarioDeJid(chat);
  const chatPropio =
    (ctx.propio !== null && usuarioChat === ctx.propio.slice(1)) || (ctx.propioLid !== null && usuarioChat === ctx.propioLid && chat.endsWith('@lid'));
  if (msg.key.fromMe && !chatPropio) return { reenviar: false, motivo: 'ESCRITO_POR_EL_TITULAR' };

  const de = chatPropio
    ? ctx.propio
    : (telefonoDesdeJid(chat) ?? telefonoDesdeJid(msg.key.senderPn ?? null) ?? telefonoDesdeJid((msg.key.remoteJidAlt as string | undefined) ?? null));
  if (!de) return { reenviar: false, motivo: 'SIN_TELEFONO' };
  if (ctx.modo === 'PERSONAL' && !chatPropio && !ctx.permitidos.has(de)) return { reenviar: false, motivo: 'NO_PERMITIDO' };
  if (contenido.tipo === 'AUDIO' && contenido.bytes !== null && contenido.bytes > ctx.audioMaxBytes) return { reenviar: false, motivo: 'AUDIO_GRANDE' };
  return { reenviar: true, id, de, contenido, chat };
}

/** Destinos a los que el puente acepta enviar (en modo PERSONAL, solo el propio y los permitidos). */
export function destinoPermitido(telefono: string, ctx: { propio: string | null; modo: Modo; permitidos: Set<string> }): boolean {
  if (!TELEFONO.test(telefono)) return false;
  return ctx.modo === 'DEDICADO' || telefono === ctx.propio || ctx.permitidos.has(telefono);
}

/** Conjunto con tamaño máximo (los más antiguos salen primero). */
export class ConjuntoAcotado {
  private readonly datos = new Set<string>();
  constructor(private readonly maximo = 5000) {}
  add(v: string): void {
    this.datos.add(v);
    if (this.datos.size > this.maximo) this.datos.delete(this.datos.values().next().value as string);
  }
  has(v: string): boolean {
    return this.datos.has(v);
  }
}
