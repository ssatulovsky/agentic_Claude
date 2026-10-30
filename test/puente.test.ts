import { describe, expect, it } from 'vitest';
import { ConjuntoAcotado, decidir, destinoPermitido, extraerContenido, leerConfiguracion, MARCA_PUENTE, telefonoDesdeJid, type MensajeEntranteWa, type Modo } from '../puente-whatsapp/src/nucleo.js';

const PROPIO = '+56911111111';
const CONTACTO = '+56922222222';
const ahoraS = 1_800_000_000;
const ctx = (modo: Modo = 'PERSONAL', permitidos: string[] = []) => ({
  propio: PROPIO,
  propioLid: '123456789012345',
  modo,
  permitidos: new Set(permitidos),
  enviados: new ConjuntoAcotado(),
  ahoraS,
  edadMaximaS: 300,
  audioMaxBytes: 8 * 1024 * 1024,
  prefijo: 'erp',
  sesionPropiaHasta: 0,
});
const msg = (p: { id?: string; chat: string; fromMe?: boolean; texto?: string; audio?: boolean; ts?: number; senderPn?: string }): MensajeEntranteWa => ({
  key: { id: p.id ?? 'M1', remoteJid: p.chat, fromMe: p.fromMe ?? false, ...(p.senderPn ? { senderPn: p.senderPn } : {}) },
  message: p.audio ? { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 5000, ptt: true } } : { conversation: p.texto ?? 'hola' },
  messageTimestamp: p.ts ?? ahoraS - 5,
});

describe('Puente WhatsApp (Baileys): qué se reenvía al ERP', () => {
  it('lee teléfonos de JID y descarta grupos, LID y textos inválidos', () => {
    expect(telefonoDesdeJid('56911111111@s.whatsapp.net')).toBe(PROPIO);
    expect(telefonoDesdeJid('56911111111:12@s.whatsapp.net')).toBe(PROPIO);
    expect(telefonoDesdeJid('123@g.us')).toBeNull();
    expect(telefonoDesdeJid('123456789012345@lid')).toBeNull();
  });

  it('con número personal solo pasa el chat consigo mismo (también por LID)', () => {
    expect(decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, texto: 'erp ¿Saldo del banco?' }), ctx())).toMatchObject({
      reenviar: true,
      de: PROPIO,
      contenido: { tipo: 'TEXTO', texto: '¿Saldo del banco?' },
      sesion: 'ABRIR',
    });
    expect(decidir(msg({ chat: '123456789012345@lid', fromMe: true, texto: 'ERP: hola' }), ctx())).toMatchObject({ reenviar: true, de: PROPIO, contenido: { texto: 'hola' } });
    // Un contacto personal nunca llega al ERP, ni lo que el titular le escribe.
    expect(decidir(msg({ chat: '56922222222@s.whatsapp.net' }), ctx())).toEqual({ reenviar: false, motivo: 'NO_PERMITIDO' });
    expect(decidir(msg({ chat: '56922222222@s.whatsapp.net', fromMe: true }), ctx())).toEqual({ reenviar: false, motivo: 'ESCRITO_POR_EL_TITULAR' });
    // Salvo que se haya permitido ese número.
    expect(decidir(msg({ chat: '56922222222@s.whatsapp.net' }), ctx('PERSONAL', [CONTACTO]))).toMatchObject({ reenviar: true, de: CONTACTO });
  });

  it('con número dedicado pasan los chats directos, con el teléfono aunque llegue como LID', () => {
    expect(decidir(msg({ chat: '56922222222@s.whatsapp.net' }), ctx('DEDICADO'))).toMatchObject({ reenviar: true, de: CONTACTO });
    expect(decidir(msg({ chat: '999999999999999@lid', senderPn: '56922222222@s.whatsapp.net' }), ctx('DEDICADO'))).toMatchObject({ reenviar: true, de: CONTACTO });
    expect(decidir(msg({ chat: '999999999999999@lid' }), ctx('DEDICADO'))).toEqual({ reenviar: false, motivo: 'SIN_TELEFONO' });
  });

  it('no se responde a sí mismo, ni a grupos, estados o mensajes antiguos', () => {
    const c = ctx();
    expect(decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, texto: `${MARCA_PUENTE}Respuesta del ERP` }), c)).toEqual({ reenviar: false, motivo: 'PROPIO' });
    c.enviados.add('ENVIADO-1');
    expect(decidir(msg({ id: 'ENVIADO-1', chat: '56911111111@s.whatsapp.net', fromMe: true }), c)).toEqual({ reenviar: false, motivo: 'PROPIO' });
    expect(decidir(msg({ chat: '120363@g.us' }), c)).toEqual({ reenviar: false, motivo: 'NO_DIRECTO' });
    expect(decidir(msg({ chat: 'status@broadcast' }), c)).toEqual({ reenviar: false, motivo: 'NO_DIRECTO' });
    expect(decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, ts: ahoraS - 3600 }), c)).toEqual({ reenviar: false, motivo: 'ANTIGUO' });
    // Lo que el titular conversa con Meta AI tampoco.
    const metaIa = msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, texto: 'erp hola' });
    metaIa.message = { conversation: 'erp hola', messageContextInfo: { botMetadata: {} } };
    expect(decidir(metaIa, c)).toEqual({ reenviar: false, motivo: 'META_IA' });
    expect(decidir(msg({ chat: '13135550002@bot', texto: 'hola' }), c)).toEqual({ reenviar: false, motivo: 'META_IA' });
  });

  it('las notas personales del chat consigo mismo no van al ERP: solo lo que empieza con «erp» y lo que sigue mientras está abierta', () => {
    const propio = (texto: string, abierta = 0) => decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, texto }), { ...ctx(), sesionPropiaHasta: abierta });
    expect(propio('Comprar pan')).toEqual({ reenviar: false, motivo: 'NOTA_PERSONAL' });
    expect(propio('erpetuo')).toEqual({ reenviar: false, motivo: 'NOTA_PERSONAL' });
    expect(propio('erp')).toMatchObject({ reenviar: true, contenido: { texto: 'ayuda' }, sesion: 'ABRIR' });
    expect(propio('VINCULAR 123456')).toMatchObject({ reenviar: true, contenido: { texto: 'VINCULAR 123456' } });
    expect(propio('¿Y el mes pasado?', ahoraS + 60)).toMatchObject({ reenviar: true, contenido: { texto: '¿Y el mes pasado?' }, sesion: 'ABRIR' });
    expect(propio('erp fin', ahoraS + 60)).toEqual({ reenviar: false, motivo: 'SESION_CERRADA', sesion: 'CERRAR' });
    // Una nota de voz solo pasa con la conversación abierta.
    const voz = (abierta: number) => decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, audio: true }), { ...ctx(), sesionPropiaHasta: abierta });
    expect(voz(0)).toEqual({ reenviar: false, motivo: 'NOTA_PERSONAL' });
    expect(voz(ahoraS + 60)).toMatchObject({ reenviar: true, contenido: { tipo: 'AUDIO' } });
  });

  it('las notas de voz se reconocen (también efímeras); archivos de audio, sin largo o muy grandes se descartan', () => {
    const contacto = (cambiar?: (a: Record<string, unknown>) => void) => {
      const m = msg({ chat: '56922222222@s.whatsapp.net', audio: true });
      cambiar?.((m.message as { audioMessage: Record<string, unknown> }).audioMessage);
      return decidir(m, ctx('DEDICADO'));
    };
    expect(contacto()).toMatchObject({ reenviar: true, contenido: { tipo: 'AUDIO', mime: 'audio/ogg; codecs=opus', bytes: 5000, notaDeVoz: true } });
    expect(contacto((a) => (a.ptt = false))).toEqual({ reenviar: false, motivo: 'AUDIO_NO_ES_NOTA_DE_VOZ' });
    expect(contacto((a) => delete a.fileLength)).toEqual({ reenviar: false, motivo: 'AUDIO_SIN_LARGO' });
    expect(extraerContenido({ ephemeralMessage: { message: { extendedTextMessage: { text: ' hola ' } } } })).toEqual({ tipo: 'TEXTO', texto: 'hola' });
    expect(extraerContenido({ imageMessage: {} })).toBeNull();
    expect(contacto((a) => (a.fileLength = 20 * 1024 * 1024))).toEqual({ reenviar: false, motivo: 'AUDIO_GRANDE' });
  });

  it('el ERP solo puede enviar al propio número y a los permitidos cuando el número es personal', () => {
    expect(destinoPermitido(PROPIO, ctx())).toBe(true);
    expect(destinoPermitido(CONTACTO, ctx())).toBe(false);
    expect(destinoPermitido(CONTACTO, ctx('PERSONAL', [CONTACTO]))).toBe(true);
    expect(destinoPermitido(CONTACTO, ctx('DEDICADO'))).toBe(true);
    expect(destinoPermitido('56922222222', ctx('DEDICADO'))).toBe(false);
  });

  it('la configuración exige el secreto y por omisión usa el modo personal', () => {
    expect(() => leerConfiguracion({ PUENTE_SECRETO: 'corto' })).toThrow(/32 caracteres/u);
    const c = leerConfiguracion({ PUENTE_SECRETO: 'x'.repeat(40), PUENTE_NUMEROS_PERMITIDOS: '+56922222222', HOME: '/home/x' });
    expect(c).toMatchObject({ modo: 'PERSONAL', host: '127.0.0.1', puerto: 3100, sesionDir: '/home/x/.erp-puente-whatsapp' });
    expect([...c.permitidos]).toEqual([CONTACTO]);
    expect(() => leerConfiguracion({ PUENTE_SECRETO: 'x'.repeat(40), PUENTE_NUMEROS_PERMITIDOS: '56922222222' })).toThrow(/inválido/u);
    expect(() => leerConfiguracion({ PUENTE_SECRETO: 'x'.repeat(40), PUENTE_EDAD_MAXIMA_S: 'abc' })).toThrow(/entero positivo/u);
    expect(leerConfiguracion({ PUENTE_SECRETO: 'x'.repeat(40), PUENTE_AUDIO_MAX_BYTES: '99999999' }).audioMaxBytes).toBe(8 * 1024 * 1024);
  });
});
