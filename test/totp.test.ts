import { describe, expect, it } from 'vitest';
import {
  base32Codificar,
  base32Decodificar,
  codigoParaPaso,
  generarSecretoTotp,
  pasoTotp,
  urlOtpAuth,
  verificarTotp,
} from '../src/seguridad/totp.js';
import { Cifrador } from '../src/seguridad/cifrado.js';
import { evaluarContrasena } from '../src/seguridad/contrasenas.js';
import { normalizarRut, rutEsValido } from '../src/utilidades/rut.js';

describe('TOTP (RFC 6238)', () => {
  // Vectores oficiales del Apéndice B del RFC 6238 (SHA-1, 8 dígitos).
  const semilla = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('en T=%i produce %s', (segundos, esperado) => {
    expect(codigoParaPaso(semilla, Math.floor(segundos / 30), 'sha1', 8)).toBe(esperado);
  });

  it('base32 ida y vuelta', () => {
    const datos = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Codificar(datos)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decodificar('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(datos)).toBe(true);
  });

  it('acepta el código actual y el de un intervalo de desfase, rechaza los demás', () => {
    const secreto = generarSecretoTotp();
    const ahora = 1_793_300_000_000;
    const paso = pasoTotp(ahora);
    const s = base32Decodificar(secreto);
    expect(verificarTotp(secreto, codigoParaPaso(s, paso), ahora)).toBe(paso);
    expect(verificarTotp(secreto, codigoParaPaso(s, paso - 1), ahora)).toBe(paso - 1);
    expect(verificarTotp(secreto, codigoParaPaso(s, paso - 3), ahora)).toBeNull();
    expect(verificarTotp(secreto, 'abcdef', ahora)).toBeNull();
  });

  it('genera una URL otpauth estándar', () => {
    const url = urlOtpAuth('ERP Agentico', 'ana@empresa.cl', 'ABC');
    expect(url).toMatch(/^otpauth:\/\/totp\/ERP%20Agentico%3Aana%40empresa\.cl\?secret=ABC&issuer=ERP\+Agentico/u);
  });
});

describe('Cifrado de secretos', () => {
  const cifrador = new Cifrador('b'.repeat(64));
  it('descifra con el mismo contexto', () => {
    const paquete = cifrador.cifrar('secreto', 'totp:usuario-1');
    expect(cifrador.descifrar(paquete, 'totp:usuario-1')).toBe('secreto');
  });
  it('rechaza un secreto copiado a otro usuario', () => {
    const paquete = cifrador.cifrar('secreto', 'totp:usuario-1');
    expect(() => cifrador.descifrar(paquete, 'totp:usuario-2')).toThrow();
  });
  it('rechaza un secreto alterado', () => {
    const paquete = cifrador.cifrar('secreto', 'ctx');
    const partes = paquete.split('.');
    partes[3] = Buffer.from('otro').toString('base64url');
    expect(() => cifrador.descifrar(partes.join('.'), 'ctx')).toThrow();
  });
});

describe('Política de contraseñas', () => {
  it('rechaza contraseñas cortas o simples', () => {
    expect(evaluarContrasena('corta').valida).toBe(false);
    expect(evaluarContrasena('todominusculasylargo').valida).toBe(false);
    expect(evaluarContrasena('Ana.Perez-2026x', 'ana.perez@empresa.cl').valida).toBe(false);
  });
  it('acepta una contraseña robusta', () => {
    expect(evaluarContrasena('Prueba-Segura-2026!').valida).toBe(true);
  });
});

describe('RUT', () => {
  it('normaliza y valida el dígito verificador', () => {
    expect(normalizarRut('76.104.550-9')).toBe('76104550-9');
    expect(normalizarRut('761045509')).toBe('76104550-9');
    expect(rutEsValido('11.111.111-1')).toBe(true);
    expect(rutEsValido('11.111.111-2')).toBe(false);
    expect(rutEsValido('12.345.678-5')).toBe(true);
  });
});
