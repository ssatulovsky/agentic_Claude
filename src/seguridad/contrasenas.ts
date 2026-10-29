import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Contraseñas con Argon2id (parámetros recomendados por OWASP: 19 MiB, 2 iteraciones).
 */
const OPCIONES = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const MUY_COMUNES = new Set([
  '123456789012',
  'contraseña123',
  'password1234',
  'qwertyuiopas',
  'administrador',
  'admin1234567',
]);

export interface ResultadoPolitica {
  valida: boolean;
  motivos: string[];
}

/** Política: mínimo 12 caracteres, al menos 3 de 4 tipos, sin el correo ni contraseñas comunes. */
export function evaluarContrasena(contrasena: string, email?: string): ResultadoPolitica {
  const motivos: string[] = [];
  if (contrasena.length < 12) motivos.push('Debe tener al menos 12 caracteres');
  if (contrasena.length > 200) motivos.push('No puede superar 200 caracteres');
  const tipos = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((r) => r.test(contrasena)).length;
  if (tipos < 3) motivos.push('Debe combinar al menos 3 de: minúsculas, mayúsculas, números y símbolos');
  if (MUY_COMUNES.has(contrasena.toLowerCase())) motivos.push('Es una contraseña demasiado común');
  const usuarioCorreo = email?.split('@')[0]?.toLowerCase();
  if (usuarioCorreo && usuarioCorreo.length >= 4 && contrasena.toLowerCase().includes(usuarioCorreo)) {
    motivos.push('No puede contener su nombre de usuario');
  }
  return { valida: motivos.length === 0, motivos };
}

export function hashearContrasena(contrasena: string): Promise<string> {
  return hash(contrasena, OPCIONES);
}

export async function verificarContrasena(hashGuardado: string, contrasena: string): Promise<boolean> {
  try {
    return await verify(hashGuardado, contrasena);
  } catch {
    return false;
  }
}

/** Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumerar correos). */
let hashFicticio: Promise<string> | null = null;
export function obtenerHashFicticio(): Promise<string> {
  hashFicticio ??= hashearContrasena('contraseña-ficticia-para-igualar-tiempos-Ñ1');
  return hashFicticio;
}
