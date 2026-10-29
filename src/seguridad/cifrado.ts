import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado autenticado AES-256-GCM para secretos guardados en la base de datos
 * (semillas de doble factor y, más adelante, certificados y claves tributarias).
 * Formato: v1.<iv>.<tag>.<texto cifrado>, cada parte en base64url.
 * El contexto (por ejemplo "totp:<usuario>") se liga al cifrado como dato
 * adicional autenticado: un secreto copiado a otro usuario no se puede descifrar.
 */
export class Cifrador {
  readonly #clave: Buffer;

  constructor(claveHex: string) {
    const clave = Buffer.from(claveHex, 'hex');
    if (clave.length !== 32) {
      throw new Error('La clave de cifrado debe tener 32 bytes');
    }
    this.#clave = clave;
  }

  cifrar(textoPlano: string, contexto: string): string {
    const iv = randomBytes(12);
    const cifrador = createCipheriv('aes-256-gcm', this.#clave, iv);
    cifrador.setAAD(Buffer.from(contexto, 'utf8'));
    const cifrado = Buffer.concat([cifrador.update(textoPlano, 'utf8'), cifrador.final()]);
    const tag = cifrador.getAuthTag();
    return ['v1', iv, tag, cifrado].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  descifrar(paquete: string, contexto: string): string {
    const partes = paquete.split('.');
    if (partes.length !== 4 || partes[0] !== 'v1') {
      throw new Error('Formato de secreto cifrado desconocido');
    }
    const [, ivB64, tagB64, datosB64] = partes as [string, string, string, string];
    const descifrador = createDecipheriv('aes-256-gcm', this.#clave, Buffer.from(ivB64, 'base64url'));
    descifrador.setAAD(Buffer.from(contexto, 'utf8'));
    descifrador.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([descifrador.update(Buffer.from(datosB64, 'base64url')), descifrador.final()]).toString(
      'utf8',
    );
  }
}
