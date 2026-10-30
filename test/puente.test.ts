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
    expect(decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, texto: '¿Saldo del banco?' }), ctx())).toMatchObject({
      reenviar: true,
      de: PROPIO,
      contenido: { tipo: 'TEXTO', texto: '¿Saldo del banco?' },
    });
    expect(decidir(msg({ chat: '123456789012345@lid', fromMe: true }), ctx())).toMatchObject({ reenviar: true, de: PROPIO });
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
  });

  it('las notas de voz se reconocen (también efímeras) y las muy grandes se descartan', () => {
    expect(decidir(msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, audio: true }), ctx())).toMatchObject({
      reenviar: true,
      contenido: { tipo: 'AUDIO', mime: 'audio/ogg; codecs=opus', bytes: 5000 },
    });
    expect(extraerContenido({ ephemeralMessage: { message: { extendedTextMessage: { text: ' hola ' } } } })).toEqual({ tipo: 'TEXTO', texto: 'hola' });
    expect(extraerContenido({ imageMessage: {} })).toBeNull();
    const grande = msg({ chat: '56911111111@s.whatsapp.net', fromMe: true, audio: true });
    (grande.message as { audioMessage: { fileLength: number } }).audioMessage.fileLength = 20 * 1024 * 1024;
    expect(decidir(grande, ctx())).toEqual({ reenviar: false, motivo: 'AUDIO_GRANDE' });
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
  });
});
