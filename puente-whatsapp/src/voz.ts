/**
 * Nota de voz de las respuestas, con Piper (texto a voz local, como hacía Vera en el
 * prototipo) y ffmpeg para dejarla en OGG/Opus, el formato de las notas de voz de WhatsApp.
 * Todo corre en el servidor: el texto no sale a ningún servicio externo.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ConfiguracionVoz {
  piperBin: string;
  /** Archivo .onnx de la voz (junto a su .onnx.json). Sin modelo, no hay notas de voz. */
  modelo: string;
  ffmpegBin: string;
}

export function leerConfiguracionVoz(entorno: NodeJS.ProcessEnv): ConfiguracionVoz | null {
  if (!entorno.PIPER_MODELO) return null;
  return { piperBin: entorno.PIPER_BIN ?? 'piper', modelo: entorno.PIPER_MODELO, ffmpegBin: entorno.FFMPEG_BIN ?? 'ffmpeg' };
}

/** Ejecuta un programa sin shell (sin interpretación de texto), con entrada y plazo. */
function ejecutar(bin: string, args: string[], entrada: string | null, plazoMs: number): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    const reloj = setTimeout(() => proc.kill('SIGKILL'), plazoMs);
    proc.stderr.on('data', (d: Buffer) => {
      if (error.length < 2000) error += d.toString();
    });
    proc.on('error', (e) => {
      clearTimeout(reloj);
      rechazar(e);
    });
    proc.on('close', (codigo) => {
      clearTimeout(reloj);
      if (codigo === 0) resolver();
      else rechazar(new Error(`${bin} terminó con código ${codigo ?? 'sin código'}`));
    });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(entrada ?? '');
  });
}

export interface NotaDeVoz {
  audio: Buffer;
  mimetype: 'audio/ogg; codecs=opus';
  segundos: number;
}

/** Sintetiza `texto` y lo devuelve como nota de voz de WhatsApp. */
export async function sintetizarNotaDeVoz(config: ConfiguracionVoz, texto: string): Promise<NotaDeVoz> {
  const dir = await mkdtemp(join(tmpdir(), 'erp-voz-'));
  try {
    const wav = join(dir, 'voz.wav');
    const ogg = join(dir, 'voz.ogg');
    // Piper lee el texto por la entrada estándar: -m modelo, -f archivo de salida.
    await ejecutar(config.piperBin, ['-m', config.modelo, '-f', wav], texto.replace(/\s+/gu, ' ').trim(), 60_000);
    const infoWav = await stat(wav);
    if (infoWav.size < 100) throw new Error('Piper no generó audio');
    const cabecera = await readFile(wav);
    // Duración aproximada desde la cabecera WAV (bytes por segundo en el byte 28).
    const bytesPorSegundo = cabecera.length >= 32 && cabecera.toString('ascii', 0, 4) === 'RIFF' ? cabecera.readUInt32LE(28) : 0;
    const segundos = bytesPorSegundo > 0 ? Math.max(1, Math.round((cabecera.length - 44) / bytesPorSegundo)) : 1;
    await ejecutar(
      config.ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '-ar', '48000', '-ac', '1', ogg],
      null,
      60_000,
    );
    const audio = await readFile(ogg);
    if (audio.length < 100) throw new Error('ffmpeg no generó audio');
    return { audio, mimetype: 'audio/ogg; codecs=opus', segundos };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Cola de a uno: la síntesis usa CPU; no se lanzan varias a la vez. */
export class ColaSerial {
  private cola: Promise<unknown> = Promise.resolve();
  agregar<T>(tarea: () => Promise<T>): Promise<T> {
    const r = this.cola.then(tarea, tarea);
    this.cola = r.catch(() => undefined);
    return r;
  }
}
