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
  /** En el chat consigo mismo, palabra que abre la conversación con el ERP (p. ej. "erp ¿saldo?"). */
  prefijo: string;
  /** Segundos que la conversación consigo mismo queda abierta tras el último mensaje al ERP. */
  ventanaS: number;
}

function enteroPositivo(nombre: string, valor: string | undefined, omision: number): number {
  if (valor === undefined || valor === '') return omision;
  if (!/^\d+$/u.test(valor) || Number(valor) <= 0) throw new Error(`${nombre} debe ser un entero positivo.`);
  return Number(valor);
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
    puerto: enteroPositivo('PUENTE_PUERTO', entorno.PUENTE_PUERTO, 3100),
    host: entorno.PUENTE_HOST ?? '127.0.0.1',
    sesionDir: entorno.PUENTE_SESION_DIR ?? `${home}/.erp-puente-whatsapp`,
    modo,
    permitidos,
    audioMaxBytes: Math.min(enteroPositivo('PUENTE_AUDIO_MAX_BYTES', entorno.PUENTE_AUDIO_MAX_BYTES, 8 * 1024 * 1024), 8 * 1024 * 1024),
    edadMaximaS: enteroPositivo('PUENTE_EDAD_MAXIMA_S', entorno.PUENTE_EDAD_MAXIMA_S, 300),
    prefijo: (entorno.PUENTE_PREFIJO ?? 'erp').trim().toLowerCase() || 'erp',
    ventanaS: enteroPositivo('PUENTE_VENTANA_S', entorno.PUENTE_VENTANA_S, 600),
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

export type Contenido = { tipo: 'TEXTO'; texto: string } | { tipo: 'AUDIO'; mime: string; bytes: number | null; notaDeVoz: boolean };

/** Texto o nota de voz de un mensaje (desenvuelve efímeros y "ver una vez"). */
export function extraerContenido(message: Record<string, unknown> | null | undefined): Contenido | null {
  if (!message) return null;
  const m = message as Record<string, any>;
  const interno =
    m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m;
  if (interno.audioMessage) {
    const largo = interno.audioMessage.fileLength;
    const bytes = largo == null ? null : Number(typeof largo === 'object' && 'toNumber' in largo ? largo.toNumber() : largo);
    return {
      tipo: 'AUDIO',
      mime: String(interno.audioMessage.mimetype ?? 'audio/ogg; codecs=opus'),
      bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
      notaDeVoz: interno.audioMessage.ptt === true,
    };
  }
  const texto = (interno.conversation ?? interno.extendedTextMessage?.text ?? '') as string;
  return texto.trim() ? { tipo: 'TEXTO', texto: texto.trim() } : null;
}

function marcaDeTiempo(v: MensajeEntranteWa['messageTimestamp']): number {
  if (v == null) return 0;
  if (typeof v === 'object') return v.toNumber();
  return Number(v);
}

/** Efecto sobre la conversación consigo mismo: se abre (o extiende) o se cierra. */
export type EfectoSesion = 'ABRIR' | 'CERRAR';

export type Decision =
  | { reenviar: true; id: string; de: string; contenido: Contenido; chat: string; sesion?: EfectoSesion }
  | { reenviar: false; motivo: string; sesion?: EfectoSesion };

const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** ¿El mensaje es de Meta AI (o va hacia Meta AI)? Esos nunca se reenvían. */
function esMetaIa(msg: MensajeEntranteWa): boolean {
  const k = msg.key as Record<string, unknown>;
  const jids = [k.remoteJid, k.participant, k.senderPn, k.remoteJidAlt, k.participantPn].filter((x): x is string => typeof x === 'string');
  const contexto = (msg.message as Record<string, any> | null | undefined)?.messageContextInfo;
  return jids.some((j) => j.endsWith('@bot')) || Boolean(contexto?.botMetadata);
}

/**
 * Decide si un mensaje se reenvía al ERP. En modo PERSONAL (número de una persona usado
 * para pruebas) solo pasan el chat consigo mismo ("Tú") y los números permitidos: los
 * contactos personales nunca llegan al ERP ni reciben respuestas.
 */
export function decidir(
  msg: MensajeEntranteWa,
  ctx: {
    propio: string | null;
    propioLid: string | null;
    modo: Modo;
    permitidos: Set<string>;
    enviados: { has(id: string): boolean };
    ahoraS: number;
    edadMaximaS: number;
    audioMaxBytes: number;
    prefijo: string;
    /** Hasta cuándo (segundos Unix) está abierta la conversación consigo mismo; 0 = cerrada. */
    sesionPropiaHasta: number;
  },
): Decision {
  const id = msg.key.id ?? '';
  const chat = msg.key.remoteJid ?? '';
  if (!id || !chat) return { reenviar: false, motivo: 'SIN_ID' };
  if (esChatNoDirecto(chat)) return { reenviar: false, motivo: 'NO_DIRECTO' };
  if (ctx.enviados.has(id)) return { reenviar: false, motivo: 'PROPIO' };
  if (esMetaIa(msg)) return { reenviar: false, motivo: 'META_IA' };
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
  if (contenido.tipo === 'AUDIO') {
    // Solo notas de voz (no archivos de audio reenviados), con largo declarado y acotado.
    if (!contenido.notaDeVoz) return { reenviar: false, motivo: 'AUDIO_NO_ES_NOTA_DE_VOZ' };
    if (contenido.bytes === null) return { reenviar: false, motivo: 'AUDIO_SIN_LARGO' };
    if (contenido.bytes > ctx.audioMaxBytes) return { reenviar: false, motivo: 'AUDIO_GRANDE' };
  }
  if (!chatPropio) return { reenviar: true, id, de, contenido, chat };

  // Chat consigo mismo: muchas personas guardan ahí notas, enlaces y fotos. Solo va al ERP lo
  // que empieza con el prefijo ("erp ¿saldo del banco?"), y lo que sigue mientras la
  // conversación está abierta (incluidas notas de voz). "erp fin" la cierra.
  if (contenido.tipo === 'TEXTO') {
    if (/^vincular\s+\d{6}$/iu.test(contenido.texto)) return { reenviar: true, id, de, contenido, chat };
    const conPrefijo = new RegExp(`^${escapar(ctx.prefijo)}(?![\\p{L}\\p{N}])[\\s,:;.\\-]*`, 'iu').exec(contenido.texto);
    if (conPrefijo) {
      const resto = contenido.texto.slice(conPrefijo[0].length).trim();
      if (/^(fin|salir|cerrar)$/iu.test(resto)) return { reenviar: false, motivo: 'SESION_CERRADA', sesion: 'CERRAR' };
      return { reenviar: true, id, de, contenido: { tipo: 'TEXTO', texto: resto || 'ayuda' }, chat, sesion: 'ABRIR' };
    }
  }
  if (ctx.ahoraS < ctx.sesionPropiaHasta) return { reenviar: true, id, de, contenido, chat, sesion: 'ABRIR' };
  return { reenviar: false, motivo: 'NOTA_PERSONAL' };
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
