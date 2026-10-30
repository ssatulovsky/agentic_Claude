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
  return config;
}
