import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
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
import { fabricaDesdeConfiguracion, type FabricaModelos } from '../ia/enrutador.js';
import { rutasIa } from './rutas/ia.js';
import { rutasWhatsapp } from './rutas/whatsapp.js';
import { PuenteHttp, type CanalMensajeria } from '../canales/whatsapp/puente.js';
import { ServicioWhatsapp } from '../canales/whatsapp/servicio.js';
import { TranscriptorCompatible, type Transcriptor } from '../canales/whatsapp/transcripcion.js';
import { rutasParametrizacion } from './rutas/parametrizacion.js';
import { rutasTesoreria } from './rutas/tesoreria.js';
import { rutasTributario } from './rutas/tributario.js';
import { rutasMaestros } from './rutas/maestros.js';
import { rutasNormativaYBitacora } from './rutas/normativa.js';

declare module 'fastify' {
  interface FastifyRequest {
    sesion?: SesionResuelta;
  }
  interface FastifyInstance {
    canalWhatsapp: ServicioWhatsapp | null;
  }
}

export const NOMBRE_COOKIE = 'erp_sesion';

export interface Dependencias {
  db: Db;
  config: Configuracion;
  autenticacion: ServicioAutenticacion;
  registro: RegistroAgentes;
  /** Clientes de los modelos de IA; por defecto, según las claves y URL de la configuración. */
  fabricaModelos?: FabricaModelos;
  /** Conexión del rol de autenticación: identifica por teléfono a quien escribe por WhatsApp. */
  dbAuth?: Db;
  /** Envío de mensajes de WhatsApp; por defecto, el puente HTTP de la configuración. */
  canalWhatsapp?: CanalMensajeria;
  /** Transcripción de notas de voz; por defecto, el servicio de la configuración (o ninguno). */
  transcriptor?: Transcriptor | null;
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

export async function crearServidor(depsEntrada: Dependencias): Promise<FastifyInstance> {
  const deps: Dependencias = { ...depsEntrada, fabricaModelos: depsEntrada.fabricaModelos ?? fabricaDesdeConfiguracion(depsEntrada.config) };
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
    // La interfaz web (/app) carga sus propios scripts y estilos; la API no carga nada.
    reply.header(
      'Content-Security-Policy',
      _req.url.startsWith('/app')
        ? "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    );
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
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
              : (error as { statusCode?: number }).statusCode === 413
                ? new ErrorNegocio('ARCHIVO_DEMASIADO_GRANDE', 'El archivo o los datos enviados exceden el tamaño permitido.', 413)
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

  // Interfaz web compilada (npm run build:web). Si no está compilada, solo se sirve la API.
  const raizWeb = deps.config.DIRECTORIO_WEB ?? join(process.cwd(), 'dist-web');
  if (existsSync(join(raizWeb, 'index.html'))) {
    // Los archivos se indexan al arrancar: después de npm run build:web hay que reiniciar el servidor.
    await app.register(fastifyStatic, {
      root: raizWeb,
      prefix: '/app/',
      index: ['index.html'],
      wildcard: false,
      list: false,
      cacheControl: false,
      setHeaders: (res, ruta) => {
        // Los archivos con hash no cambian nunca; index.html no se guarda en caché.
        res.header('Cache-Control', ruta.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store');
      },
    });
    app.get('/', async (_req, reply) => reply.redirect('/app/'));
    app.get('/app', async (_req, reply) => reply.redirect('/app/'));
    // Rutas de la aplicación de una sola página: devuelven index.html. Un archivo de
    // assets inexistente es 404 (no index.html, que el navegador rechazaría como script).
    app.get('/app/*', async (req, reply) => {
      if (req.url.startsWith('/app/assets/')) {
        return reply.status(404).send({ error: { codigo: 'NO_ENCONTRADO', mensaje: 'Archivo no encontrado.' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }

  await app.register(async (r) => rutasAutenticacion(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasAdministracion(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasMaestros(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasNormativaYBitacora(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasAgentes(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasContabilidad(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasTributario(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasTesoreria(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasParametrizacion(r, deps), { prefix: '/api' });
  await app.register(async (r) => rutasIa(r, deps), { prefix: '/api' });

  // Canal WhatsApp: activo solo con secreto del puente, conexión de autenticación y forma de enviar.
  const c = deps.config;
  const salida = deps.canalWhatsapp ?? (c.WHATSAPP_PUENTE_URL && c.WHATSAPP_PUENTE_SECRETO ? new PuenteHttp({ url: c.WHATSAPP_PUENTE_URL, secreto: c.WHATSAPP_PUENTE_SECRETO }) : null);
  const whatsapp =
    c.WHATSAPP_PUENTE_SECRETO && deps.dbAuth && salida
      ? new ServicioWhatsapp({
          db: deps.db,
          dbAuth: deps.dbAuth,
          registro: deps.registro,
          fabricaModelos: deps.fabricaModelos!,
          canal: salida,
          transcriptor:
            deps.transcriptor !== undefined
              ? deps.transcriptor
              : c.TRANSCRIPCION_URL
                ? new TranscriptorCompatible({ url: c.TRANSCRIPCION_URL, modelo: c.TRANSCRIPCION_MODELO, ...(c.TRANSCRIPCION_API_KEY ? { apiKey: c.TRANSCRIPCION_API_KEY } : {}) })
                : null,
          claveMaestra: c.CLAVE_MAESTRA_CIFRADO,
          plazoConversacionMs: c.IA_PLAZO_CONVERSACION_MS,
          avisarNoVinculados: c.WHATSAPP_AVISAR_NO_VINCULADOS === 'true',
          registrar: { warn: (d, m) => app.log.warn(d, m), error: (d, m) => app.log.error(d, m) },
        })
      : null;
  app.decorate('canalWhatsapp', whatsapp);
  app.addHook('onClose', async () => {
    // Plazo acotado: lo que quede a medias, el conector lo reenvía y se reprocesa.
    await whatsapp?.esperarPendientes(20_000);
  });
  await app.register(async (r) => rutasWhatsapp(r, deps, whatsapp), { prefix: '/api' });

  return app;
}
