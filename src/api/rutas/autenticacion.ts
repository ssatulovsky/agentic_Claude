import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirSesion, NOMBRE_COOKIE, validar, type Dependencias } from '../servidor.js';

const cuerpoLogin = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  contrasena: z.string().min(1).max(200),
});
const cuerpoCodigo = z.object({ codigo: z.string().regex(/^\d{6}$/u, 'El código tiene 6 dígitos') });

export async function rutasAutenticacion(app: FastifyInstance, deps: Dependencias): Promise<void> {
  const opcionesCookie = {
    httpOnly: true,
    secure: deps.config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: deps.config.SESION_DURACION_HORAS * 3600,
  };

  app.post('/auth/login', { config: { rateLimit: { max: deps.config.LIMITE_LOGIN_POR_MINUTO, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email, contrasena } = validar(cuerpoLogin, req.body);
    const resultado = await deps.autenticacion.iniciarSesion(email, contrasena, req.ip, req.headers['user-agent'] ?? null);
    reply.setCookie(NOMBRE_COOKIE, resultado.token, opcionesCookie);
    return {
      siguientePaso: resultado.requiereEnrolarMfa ? 'ENROLAR_MFA' : 'VERIFICAR_MFA',
    };
  });

  app.post(
    '/auth/mfa/enrolar',
    { preHandler: exigirSesion(deps, { permitirSinMfa: true }), config: { rateLimit: { max: deps.config.LIMITE_LOGIN_POR_MINUTO, timeWindow: '1 minute' } } },
    async (req) => {
      const sesion = req.sesion!;
      const usuario = await enContexto(deps.db, contextoDeUsuario(sesion.usuarioId), (trx) =>
        trx.selectFrom('usuarios').select('email').where('id', '=', sesion.usuarioId).executeTakeFirstOrThrow(),
      );
      // La semilla se muestra una sola vez para que el usuario la registre en su aplicación.
      return deps.autenticacion.iniciarEnrolamientoMfa(sesion, usuario.email);
    },
  );

  app.post(
    '/auth/mfa/activar',
    { preHandler: exigirSesion(deps, { permitirSinMfa: true }), config: { rateLimit: { max: deps.config.LIMITE_LOGIN_POR_MINUTO, timeWindow: '1 minute' } } },
    async (req) => {
      const { codigo } = validar(cuerpoCodigo, req.body);
      await deps.autenticacion.activarMfa(req.sesion!, codigo);
      return { mfaActivo: true };
    },
  );

  app.post(
    '/auth/mfa/verificar',
    { preHandler: exigirSesion(deps, { permitirSinMfa: true }), config: { rateLimit: { max: deps.config.LIMITE_LOGIN_POR_MINUTO, timeWindow: '1 minute' } } },
    async (req) => {
      const { codigo } = validar(cuerpoCodigo, req.body);
      await deps.autenticacion.verificarMfa(req.sesion!, codigo);
      return { verificado: true };
    },
  );

  app.post('/auth/logout', { preHandler: exigirSesion(deps, { permitirSinMfa: true }) }, async (req, reply) => {
    await deps.autenticacion.cerrarSesion(req.sesion!);
    reply.clearCookie(NOMBRE_COOKIE, { path: '/' });
    return { sesionCerrada: true };
  });

  /** Datos del usuario y empresas que puede elegir como contexto de trabajo. */
  app.get('/yo', { preHandler: exigirSesion(deps) }, async (req) => {
    const sesion = req.sesion!;
    return enContexto(deps.db, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      const usuario = await trx
        .selectFrom('usuarios')
        .select(['id', 'email', 'nombre', 'cliente_erp_id'])
        .where('id', '=', sesion.usuarioId)
        .executeTakeFirstOrThrow();
      const { rows: empresas } = await sql<{ id: string; rut: string; razon_social: string; tipo: string; estado: string }>`
        SELECT * FROM app_empresas_accesibles()`.execute(trx);
      return { usuario, empresas };
    });
  });
}
