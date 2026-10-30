import { z } from 'zod';

/**
 * Configuración del sistema. Se valida al arrancar: si falta una variable o es
 * débil, el proceso no inicia. No existen valores por defecto para secretos.
 */
const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUERTO: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Conexión de la aplicación (rol erp_app, sujeto a seguridad por fila). */
  DATABASE_URL: z.string().url(),
  /** Conexión del servicio de autenticación (rol erp_auth): único que accede a contraseñas y sesiones. */
  DATABASE_URL_AUTH: z.string().url(),
  /** Conexión de migraciones (rol erp_owner). Solo la usa el migrador. */
  DATABASE_URL_MIGRACIONES: z.string().url().optional(),
  /** Clave maestra AES-256 en hexadecimal (64 caracteres). Debe venir de un gestor de secretos. */
  CLAVE_MAESTRA_CIFRADO: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'CLAVE_MAESTRA_CIFRADO debe ser de 32 bytes en hexadecimal (64 caracteres)'),
  /** Duración máxima de una sesión, en horas. */
  SESION_DURACION_HORAS: z.coerce.number().positive().max(24).default(8),
  /** Minutos de inactividad tras los cuales la sesión vence. */
  SESION_INACTIVIDAD_MINUTOS: z.coerce.number().positive().max(240).default(30),
  /** Intentos de ingreso y de doble factor permitidos por minuto y por IP. */
  LIMITE_LOGIN_POR_MINUTO: z.coerce.number().int().min(1).max(10_000).default(10),
  /**
   * Cantidad de proxies inversos de confianza delante del servidor (balanceador, CDN).
   * 0 = ninguno: la IP del cliente es la de la conexión. Nunca confiar en todos los saltos,
   * porque la cabecera X-Forwarded-For la controla el cliente.
   */
  PROXIES_CONFIABLES: z.coerce.number().int().min(0).max(5).default(0),
  /** Nombre que se muestra en la aplicación de doble factor. */
  MFA_EMISOR: z.string().min(1).default('ERP Agentico'),
  /** Carpeta de la interfaz web compilada; por defecto dist-web en el directorio de trabajo. */
  DIRECTORIO_WEB: z.string().min(1).optional(),
  /** Proveedores de IA. Sin clave o sin URL, ese proveedor se salta y la cadena sigue con el siguiente. */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  GEMINI_API_KEY: z.string().min(10).optional(),
  OLLAMA_URL: z.url().optional(),
  OLLAMA_MODELO: z.string().min(1).optional(),
  /** Tiempo máximo de espera por respuesta de un modelo. */
  IA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  // Plazo total de una consulta a un agente (todos los pasos y modelos de respaldo).
  IA_PLAZO_CONVERSACION_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  // Canal WhatsApp: conector (puente) que recibe y envía mensajes. Ambos se autentican
  // con firma HMAC-SHA256 con este secreto compartido.
  WHATSAPP_PUENTE_URL: z.url().optional(),
  WHATSAPP_PUENTE_SECRETO: z.string().min(32).optional(),
  // Direcciones IP desde las que puede llamar el puente (separadas por coma). Vacío = cualquiera (solo firma).
  WHATSAPP_PUENTE_IPS: z.string().optional(),
  // Avisar a números no vinculados que deben vincularse. Con un número personal de pruebas, false.
  WHATSAPP_AVISAR_NO_VINCULADOS: z.enum(['true', 'false']).default('true'),
  // Número de WhatsApp de la plataforma, para mostrarlo en la web al vincular.
  WHATSAPP_NUMERO: z.string().regex(/^\+[1-9]\d{7,14}$/u).optional(),
  // Transcripción de notas de voz: servidor compatible con /v1/audio/transcriptions (p. ej. Whisper local).
  TRANSCRIPCION_URL: z.url().optional(),
  TRANSCRIPCION_MODELO: z.string().min(1).default('whisper-1'),
  TRANSCRIPCION_API_KEY: z.string().min(1).optional(),
  // Una nota de voz puede contener una clave dictada: la transcripción debe ser local salvo
  // autorización expresa para usar un servicio externo.
  TRANSCRIPCION_EXTERNA_AUTORIZADA: z.enum(['true', 'false']).default('false'),
});

export type Configuracion = z.infer<typeof esquema>;

export function cargarConfiguracion(entorno: NodeJS.ProcessEnv = process.env): Configuracion {
  const resultado = esquema.safeParse(entorno);
  if (!resultado.success) {
    const detalle = resultado.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida. Revise las variables de entorno:\n${detalle}`);
  }
  const config = resultado.data;
  if (config.NODE_ENV === 'production' && /^0+$/.test(config.CLAVE_MAESTRA_CIFRADO)) {
    throw new Error('CLAVE_MAESTRA_CIFRADO no puede ser una clave trivial en producción');
  }
  if (config.TRANSCRIPCION_URL && !esHostLocal(new URL(config.TRANSCRIPCION_URL).hostname) && config.TRANSCRIPCION_EXTERNA_AUTORIZADA !== 'true') {
    throw new Error(
      'TRANSCRIPCION_URL apunta a un servicio externo: las notas de voz podrían llevar claves dictadas. Use un servicio local o autorícelo con TRANSCRIPCION_EXTERNA_AUTORIZADA=true.',
    );
  }
  return config;
}

/** true si el host es la propia máquina, una red privada o un nombre interno (sin punto o .local/.internal). */
export function esHostLocal(host: string): boolean {
  const h = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (h.includes(':')) return /^f[cd]/u.test(h); // IPv6 local única (fc00::/7)
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !h.includes('.') || /\.(local|internal|lan)$/u.test(h);
}
