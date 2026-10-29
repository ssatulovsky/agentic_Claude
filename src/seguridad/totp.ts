import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Códigos de un solo uso basados en tiempo (TOTP, RFC 6238) compatibles con
 * Google Authenticator, Microsoft Authenticator, 1Password, etc.
 * Implementado con la librería criptográfica de Node y probado con los
 * vectores oficiales del RFC.
 */

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIODO_SEGUNDOS = 30;
const DIGITOS = 6;

export function base32Codificar(datos: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of datos) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    salida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  }
  return salida;
}

export function base32Decodificar(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '');
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const caracter of limpio) {
    const indice = ALFABETO_BASE32.indexOf(caracter);
    if (indice < 0) {
      throw new Error('Secreto base32 inválido');
    }
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Genera una semilla nueva de 160 bits, en base32. */
export function generarSecretoTotp(): string {
  return base32Codificar(randomBytes(20));
}

export function pasoTotp(instanteMs: number): number {
  return Math.floor(instanteMs / 1000 / PERIODO_SEGUNDOS);
}

/** Código HOTP (RFC 4226) para un contador dado. */
export function codigoParaPaso(
  secreto: Buffer,
  paso: number,
  algoritmo: 'sha1' | 'sha256' | 'sha512' = 'sha1',
  digitos = DIGITOS,
): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const hmac = createHmac(algoritmo, secreto).update(contador).digest();
  const desplazamiento = hmac[hmac.length - 1]! & 0x0f;
  const binario =
    ((hmac[desplazamiento]! & 0x7f) << 24) |
    (hmac[desplazamiento + 1]! << 16) |
    (hmac[desplazamiento + 2]! << 8) |
    hmac[desplazamiento + 3]!;
  return String(binario % 10 ** digitos).padStart(digitos, '0');
}

/**
 * Verifica un código aceptando un intervalo de desfase hacia atrás o adelante.
 * Devuelve el paso que coincidió (para impedir su reutilización) o null.
 */
export function verificarTotp(secretoBase32: string, codigo: string, instanteMs = Date.now(), ventana = 1): number | null {
  if (!/^\d{6}$/u.test(codigo)) {
    return null;
  }
  const secreto = base32Decodificar(secretoBase32);
  const actual = pasoTotp(instanteMs);
  const recibido = Buffer.from(codigo);
  let coincidencia: number | null = null;
  // Se recorren todos los pasos de la ventana para no revelar cuál coincidió por tiempo.
  for (let desfase = -ventana; desfase <= ventana; desfase++) {
    const paso = actual + desfase;
    const esperado = Buffer.from(codigoParaPaso(secreto, paso));
    if (timingSafeEqual(esperado, recibido) && coincidencia === null) {
      coincidencia = paso;
    }
  }
  return coincidencia;
}

export function urlOtpAuth(emisor: string, cuenta: string, secretoBase32: string): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  const parametros = new URLSearchParams({
    secret: secretoBase32,
    issuer: emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PERIODO_SEGUNDOS),
  });
  return `otpauth://totp/${etiqueta}?${parametros.toString()}`;
}
