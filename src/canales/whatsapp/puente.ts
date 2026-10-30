import { cabecerasFirmadas } from './firma.js';

/**
 * Canal de mensajería saliente. Hoy lo implementa el puente HTTP del conector web de
 * WhatsApp; pasar a la API oficial de Meta es escribir otra implementación de esta interfaz.
 */
export interface CanalMensajeria {
  /** `voz`: texto para decir además en una nota de voz (el texto escrito va siempre). */
  enviar(telefono: string, texto: string, opciones?: { voz?: string }): Promise<void>;
}

/** Largo máximo de un mensaje de WhatsApp (con margen). */
export const LARGO_MAXIMO = 4000;

/** Parte un texto largo en mensajes, cortando en saltos de línea o espacios. */
export function partirTexto(texto: string, largo = LARGO_MAXIMO): string[] {
  const partes: string[] = [];
  let resto = texto.trim();
  while (resto.length > largo) {
    let corte = resto.lastIndexOf('\n', largo);
    if (corte < largo / 2) corte = resto.lastIndexOf(' ', largo);
    if (corte < largo / 2) corte = largo;
    partes.push(resto.slice(0, corte).trimEnd());
    resto = resto.slice(corte).trimStart();
  }
  if (resto) partes.push(resto);
  return partes;
}

/** Envía por el puente: POST {url}/enviar con { para, texto }, firmado con HMAC. */
export class PuenteHttp implements CanalMensajeria {
  constructor(
    private readonly opciones: { url: string; secreto: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async enviar(telefono: string, texto: string, opciones: { voz?: string } = {}): Promise<void> {
    const partes = partirTexto(texto);
    for (const [i, parte] of partes.entries()) {
      // La nota de voz acompaña la última parte del texto.
      const voz = i === partes.length - 1 && opciones.voz ? { voz: opciones.voz } : {};
      const cuerpo = JSON.stringify({ para: telefono, texto: parte, ...voz });
      const r = await (this.opciones.fetch ?? fetch)(`${this.opciones.url.replace(/\/$/u, '')}/enviar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cabecerasFirmadas(this.opciones.secreto, 'POST /enviar', cuerpo) },
        body: cuerpo,
        signal: AbortSignal.timeout(this.opciones.timeoutMs ?? 15_000),
      });
      if (!r.ok) throw new Error(`El puente de WhatsApp respondió HTTP ${r.status}`);
    }
  }
}
