import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RegistroAgentes } from '../agentes/catalogo.js';
import type { Configuracion } from '../config.js';
import type { Db } from '../db/conexion.js';
import { ErrorNegocio, noAutenticado, traducirErrorBaseDatos } from '../errores.js';
import type { ServicioAutenticacion, SesionResuelta } from '../seguridad/autenticacion.js';
import { rutasAdministracion } from './rutas/administracion.js';
import { rutasAgentes } from './rutas/agentes.js';
import { rutasAutenticacion } from './rutas/autenticacion.js';
import { rutasContabilidad } from './rutas/contabilidad.js';
import { rutasMaestros } from './rutas/maestros.js';
import { rutasNormativaYBitacora } from './rutas/normativa.js';

declare module 'fastify' {
  interface FastifyRequest {
    sesion?: SesionResuelta;
  }
}

export const NOMBRE_COOKIE = 'erp_sesion';

export interface Dependencias {
  db: Db;
  config: Configuracion;
  autenticacion: ServicioAutenticacion;
  registro: RegistroAgentes;
}

/** Valida un cuerpo, parámetros o consulta con zod y devuelve un error 422 legible si no cumple. */
export function validar<T>(esquema: z.ZodType<T>, datos: unknown): T {
  const r = esquema.safeParse(datos);
  if (!r.success) {
    throw new ErrorNegocio(
      'DATOS_INVALIDOS',
      'Los datos enviados no son válidos.',
      422,
      r.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    );
  }
  return r.data;
}

export const paramEmpresa = z.object({ empresaId: z.uuid() });

/**
 * Exige una sesión. Por defecto exige además el doble factor verificado; solo las
 * rutas del propio flujo de doble factor aceptan una sesión a medio verificar.
 */
export function exigirSesion(deps: Dependencias, opciones: { permitirSinMfa?: boolean } = {}) {
  return async (req: FastifyRequest): Promise<void> => {
    const sesion = await deps.autenticacion.resolverSesion(req.cookies[NOMBRE_COOKIE]);
    if (!sesion) throw noAutenticado();
    if (!sesion.mfaVerificada && !opciones.permitirSinMfa) {
      throw new ErrorNegocio(
        sesion.totpActivo ? 'MFA_REQUERIDA' : 'MFA_ENROLAMIENTO_REQUERIDO',
        sesion.totpActivo
          ? 'Debe ingresar el código de doble factor.'
          : 'Debe configurar el doble factor antes de continuar.',
        401,
      );
    }
    req.sesion = sesion;
  };
}

export async function crearServidor(deps: Dependencias): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.body'] },
    bodyLimit: 1_048_576,
    // Solo se confía en los N saltos de proxy propios; el resto de X-Forwarded-For lo controla el cliente.
    trustProxy:
      deps.config.PROXIES_CONFIABLES > 0 ? (_direccion: string, salto: number) => salto < deps.config.PROXIES_CONFIABLES : false,
  });

  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // Protección CSRF, además de la cookie SameSite=Strict: toda petición que modifica
  // datos debe ser JSON o, si no lleva cuerpo, traer la cabecera X-ERP-Solicitud.
  // Un formulario o enlace de otro sitio no puede hacer ninguna de las dos cosas
  // sin pasar por la verificación CORS del navegador.
  app.addHook('onRequest', async (req) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const tipo = req.headers['content-type'] ?? '';
      const tieneCuerpo = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'];
      if (tieneCuerpo ? !tipo.startsWith('application/json') : req.headers['x-erp-solicitud'] !== '1') {
        throw new ErrorNegocio(
          'TIPO_CONTENIDO',
          'Las peticiones deben enviarse como application/json o, sin cuerpo, con la cabecera X-ERP-Solicitud: 1.',
          415,
        );
      }
    }
  });

  app.addHook('onSend', async (_req, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    if (deps.config.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const negocio =
      error instanceof ErrorNegocio
        ? error
        : (traducirErrorBaseDatos(error) ??
          ((error as { statusCode?: number }).statusCode === 429
            ? new ErrorNegocio('DEMASIADAS_PETICIONES', 'Demasiadas peticiones. Espere un momento.', 429)
            : (error as { validation?: unknown }).validation
              ? new ErrorNegocio('DATOS_INVALIDOS', (error as Error).message, 400)
              : (error as { statusCode?: number }).statusCode === 415
                ? new ErrorNegocio('TIPO_CONTENIDO', 'Tipo de contenido no soportado.', 415)
                : null));
    if (negocio) {
      return reply.status(negocio.estadoHttp).send({
        error: { codigo: negocio.codigo, mensaje: negocio.message, detalle: negocio.detalle },
      });
    }
    req.log.error({ err: error }, 'Error no controlado');
    return reply.status(500).send({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Ocurrió un error inesperado.' } });
  });

  app.get('/api/salud', async () => ({ estado: 'ok' }));

  await app.register(async (r) => rutasAutenticacion(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasAdministracion(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasMaestros(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasNormativaYBitacora(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasAgentes(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasContabilidad(r, deps), { prefix: '/api' });

  return app;
}
