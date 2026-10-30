import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ColaSerial, leerConfiguracionVoz, limpiarTemporales, sintetizarNotaDeVoz } from '../puente-whatsapp/src/voz.js';

/** Programas de reemplazo: "piper" escribe un WAV de 1 s; "ffmpeg" copia y marca OGG. */
function programasFalsos(dir: string) {
  const piper = join(dir, 'piper');
  writeFileSync(
    piper,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const salida = args[args.indexOf('-f') + 1];
let texto = '';
process.stdin.on('data', (d) => (texto += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(dir, 'texto.txt'))}, texto);
  const datos = Buffer.alloc(22050 * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + datos.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24);
  h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(datos.length, 40);
  fs.writeFileSync(salida, Buffer.concat([h, datos]));
});
`,
  );
  const ffmpeg = join(dir, 'ffmpeg');
  writeFileSync(
    ffmpeg,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[args.length - 1], Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200)]));
`,
  );
  chmodSync(piper, 0o755);
  chmodSync(ffmpeg, 0o755);
  return { piper, ffmpeg };
}

const tieneFfmpegConOpus = (() => {
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libopus');
  } catch {
    return false;
  }
})();

describe('Nota de voz del puente (Piper + ffmpeg)', () => {
  it('sin modelo de voz configurado no hay notas de voz', () => {
    expect(leerConfiguracionVoz({})).toBeNull();
    expect(leerConfiguracionVoz({ PIPER_MODELO: '/voces/es_AR-daniela-high.onnx' })).toEqual({ piperBin: 'piper', modelo: '/voces/es_AR-daniela-high.onnx', ffmpegBin: 'ffmpeg' });
  });

  it('pasa el texto por la entrada estándar (sin shell), devuelve OGG/Opus y no deja archivos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voz-prueba-'));
    const { piper, ffmpeg } = programasFalsos(dir);
    const base = mkdtempSync(join(tmpdir(), 'voz-base-'));
    const texto = 'Saldo: 790000 pesos; "comillas" $(rm -rf /) `x`';
    const nota = await sintetizarNotaDeVoz({ piperBin: piper, modelo: '/m.onnx', ffmpegBin: ffmpeg }, texto, base);
    expect(nota.audio.subarray(0, 4).toString()).toBe('OggS');
    expect(nota).toMatchObject({ mimetype: 'audio/ogg; codecs=opus', segundos: 1 });
    expect(execFileSync('cat', [join(dir, 'texto.txt')], { encoding: 'utf8' })).toBe(texto);
    expect(readdirSync(base)).toEqual([]);
  });

  it('al arrancar se borran los temporales de una ejecución interrumpida', async () => {
    const base = mkdtempSync(join(tmpdir(), 'voz-base-'));
    mkdtempSync(join(base, 'erp-voz-'));
    writeFileSync(join(base, 'otro.txt'), 'x');
    expect(await limpiarTemporales(base)).toBe(1);
    expect(readdirSync(base)).toEqual(['otro.txt']);
  });

  it.runIf(tieneFfmpegConOpus)('con ffmpeg real, el resultado es una nota de voz OGG/Opus válida', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voz-prueba-'));
    const { piper } = programasFalsos(dir);
    const nota = await sintetizarNotaDeVoz({ piperBin: piper, modelo: '/m.onnx', ffmpegBin: 'ffmpeg' }, 'hola');
    expect(nota.audio.subarray(0, 4).toString()).toBe('OggS');
    expect(nota.audio.includes(Buffer.from('OpusHead'))).toBe(true);
  });

  it('si Piper falla, se informa el error (la respuesta ya fue por escrito)', async () => {
    await expect(sintetizarNotaDeVoz({ piperBin: '/no/existe/piper', modelo: '/m.onnx', ffmpegBin: 'ffmpeg' }, 'hola')).rejects.toThrow();
  });

  it('la cola sintetiza de a una aunque una falle, con tope de pendientes y sin tareas vencidas', async () => {
    const cola = new ColaSerial(3, 1000);
    const orden: number[] = [];
    const espera = (ms: number, n: number) => () => new Promise<void>((r) => setTimeout(() => (orden.push(n), r()), ms));
    const a = cola.agregar(espera(30, 1));
    const b = cola.agregar(() => Promise.reject(new Error('x')));
    const c = cola.agregar(espera(1, 3));
    expect(cola.agregar(espera(1, 4))).toBeNull();
    await Promise.allSettled([a, b, c]);
    expect(orden).toEqual([1, 3]);
    // Una tarea que esperó más de lo permitido no se ejecuta.
    const lenta = new ColaSerial(5, 10);
    const primera = lenta.agregar(espera(40, 5));
    const vencida = lenta.agregar(espera(1, 6));
    expect(await primera).toBeUndefined();
    expect(await vencida).toBe('VENCIDA');
    expect(orden).toEqual([1, 3, 5]);
  });
});
