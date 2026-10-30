/**
 * Transcripción de notas de voz. Por defecto, un servidor local compatible con
 * POST /v1/audio/transcriptions (Whisper): el audio no sale del servidor.
 */
export interface Transcriptor {
  transcribir(audio: Buffer, mime: string): Promise<string>;
}

const EXTENSIONES: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export function mimeAudioAceptado(mime: string): boolean {
  return mime.split(';')[0]!.trim().toLowerCase() in EXTENSIONES;
}

export class TranscriptorCompatible implements Transcriptor {
  constructor(
    private readonly opciones: { url: string; modelo: string; apiKey?: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async transcribir(audio: Buffer, mime: string): Promise<string> {
    const tipo = mime.split(';')[0]!.trim().toLowerCase();
    const formulario = new FormData();
    formulario.append('file', new Blob([new Uint8Array(audio)], { type: tipo }), `audio.${EXTENSIONES[tipo] ?? 'ogg'}`);
    formulario.append('model', this.opciones.modelo);
    formulario.append('language', 'es');
    formulario.append('response_format', 'json');
    const r = await (this.opciones.fetch ?? fetch)(`${this.opciones.url.replace(/\/$/u, '')}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: this.opciones.apiKey ? { authorization: `Bearer ${this.opciones.apiKey}` } : {},
      body: formulario,
      signal: AbortSignal.timeout(this.opciones.timeoutMs ?? 60_000),
    });
    if (!r.ok) throw new Error(`El servicio de transcripción respondió HTTP ${r.status}`);
    const datos = (await r.json()) as { text?: unknown };
    if (typeof datos.text !== 'string') throw new Error('Respuesta de transcripción sin texto');
    return datos.text.trim();
  }
}
