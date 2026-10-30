import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cerrarEjercicio,
  cerrarPeriodo,
  configurarContabilidad,
  obtenerConfiguracionContable,
  crearEjercicio,
  listarAsientos,
  listarEjercicios,
  obtenerAsiento,
  reabrirPeriodo,
  registrarAsiento,
  resolverReaperturaEjercicio,
  reversarAsiento,
  solicitarReaperturaEjercicio,
} from '../../contabilidad/libroDiario.js';
import { balanceOchoColumnas, libroMayor } from '../../contabilidad/reportes.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD');
// Montos sobre un billón deben enviarse como texto (precisión de los números JSON).
const monto = z.union([z.number().nonnegative().max(999_999_999_999), z.string().regex(/^\d{1,16}(\.\d{1,2})?$/u)]);
const motivo = z.string().trim().min(10).max(500);

const cuerpoAsiento = z.object({
  fecha,
  glosa: z.string().trim().min(3).max(300),
  tipo: z.enum(['NORMAL', 'APERTURA', 'AJUSTE']).optional(),
  documentoReferencia: z.string().trim().max(100).optional(),
  lineas: z
    .array(
      z.object({
        cuenta: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u),
        debe: monto.optional(),
        haber: monto.optional(),
        tercero: z.string().trim().max(12).optional(),
        centroCosto: z.string().trim().max(20).optional(),
        glosa: z.string().trim().max(200).optional(),
      }),
    )
    .min(2)
    .max(500),
});

export async function rutasContabilidad(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));
  const enEmpresa = <T>(usuarioId: string, empresaId: string, fn: Parameters<typeof enContexto<T>>[2]) =>
    enContexto(deps.db, contextoDeUsuario(usuarioId, empresaId), fn);

  // ---------------- Configuración contable ----------------
  app.get('/empresas/:empresaId/configuracion-contable', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return obtenerConfiguracionContable(trx, empresaId);
    });
  });

  app.put('/empresas/:empresaId/configuracion-contable', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const { cuentaResultadoEjercicio } = validar(
      z.object({ cuentaResultadoEjercicio: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u) }),
      req.body,
    );
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => configurarContabilidad(trx, empresaId, cuentaResultadoEjercicio));
    return { cuentaResultadoEjercicio };
  });

  // ---------------- Ejercicios y períodos ----------------
  app.get('/empresas/:empresaId/ejercicios', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return listarEjercicios(trx, empresaId);
    });
  });

  app.post('/empresas/:empresaId/ejercicios', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const { anio, fechaInicio } = validar(
      z.object({ anio: z.number().int().min(2000).max(2100), fechaInicio: fecha.optional() }),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => crearEjercicio(trx, empresaId, anio, fechaInicio));
    return reply.status(201).send({ id });
  });

  app.post('/empresas/:empresaId/periodos/:periodoId/cerrar', async (req) => {
    const { empresaId, periodoId } = validar(paramEmpresa.extend({ periodoId: z.uuid() }), req.params);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => cerrarPeriodo(trx, periodoId));
    return { estado: 'CERRADO' };
  });

  app.post('/empresas/:empresaId/periodos/:periodoId/reabrir', async (req) => {
    const { empresaId, periodoId } = validar(paramEmpresa.extend({ periodoId: z.uuid() }), req.params);
    const datos = validar(z.object({ motivo }), req.body);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => reabrirPeriodo(trx, periodoId, datos.motivo));
    return { estado: 'ABIERTO' };
  });

  app.post('/empresas/:empresaId/ejercicios/:ejercicioId/cerrar', async (req) => {
    const { empresaId, ejercicioId } = validar(paramEmpresa.extend({ ejercicioId: z.uuid() }), req.params);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => cerrarEjercicio(trx, ejercicioId));
    return { estado: 'CERRADO' };
  });

  app.post('/empresas/:empresaId/ejercicios/:ejercicioId/solicitudes-reapertura', async (req, reply) => {
    const { empresaId, ejercicioId } = validar(paramEmpresa.extend({ ejercicioId: z.uuid() }), req.params);
    const d = validar(
      z.object({
        motivo: z.string().trim().min(20).max(1000),
        actaReferencia: z.string().trim().min(3).max(200),
        plazoDias: z.number().int().min(1).max(90),
      }),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) =>
      solicitarReaperturaEjercicio(trx, ejercicioId, d.motivo, d.actaReferencia, d.plazoDias),
    );
    return reply.status(201).send({ id, estado: 'PENDIENTE' });
  });

  app.post('/empresas/:empresaId/solicitudes-reapertura/:solicitudId/resolver', async (req) => {
    const { empresaId, solicitudId } = validar(paramEmpresa.extend({ solicitudId: z.uuid() }), req.params);
    const d = validar(
      z.object({ decision: z.enum(['APROBAR', 'RECHAZAR']), comentario: z.string().trim().max(500).optional() }),
      req.body,
    );
    const estado = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) =>
      resolverReaperturaEjercicio(trx, solicitudId, d.decision, d.comentario ?? null),
    );
    return { estado };
  });

  // ---------------- Asientos ----------------
  app.post('/empresas/:empresaId/asientos', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const a = validar(cuerpoAsiento, req.body);
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) =>
      registrarAsiento(trx, {
        empresaId,
        fecha: a.fecha,
        glosa: a.glosa,
        lineas: a.lineas,
        tipo: a.tipo ?? 'NORMAL',
        documentoReferencia: a.documentoReferencia ?? null,
      }),
    );
    return reply.status(201).send(r);
  });

  app.get('/empresas/:empresaId/asientos', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const q = validar(z.object({ desde: fecha, hasta: fecha, limite: z.coerce.number().int().min(1).max(1000).optional() }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return listarAsientos(trx, empresaId, q.desde, q.hasta, q.limite ?? 200);
    });
  });

  app.get('/empresas/:empresaId/asientos/:asientoId', async (req) => {
    const { empresaId, asientoId } = validar(paramEmpresa.extend({ asientoId: z.uuid() }), req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return obtenerAsiento(trx, empresaId, asientoId);
    });
  });

  app.post('/empresas/:empresaId/asientos/:asientoId/reversar', async (req, reply) => {
    const { empresaId, asientoId } = validar(paramEmpresa.extend({ asientoId: z.uuid() }), req.params);
    const d = validar(z.object({ fecha, motivo }), req.body);
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => reversarAsiento(trx, asientoId, d.fecha, d.motivo));
    return reply.status(201).send(r);
  });

  // ---------------- Reportes ----------------
  app.get('/empresas/:empresaId/mayor', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const q = validar(z.object({ cuenta: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u), desde: fecha, hasta: fecha }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return libroMayor(trx, empresaId, q.cuenta, q.desde, q.hasta);
    });
  });

  app.get('/empresas/:empresaId/balance-8-columnas', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const q = validar(z.object({ hasta: fecha }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.asientos.ver');
      return balanceOchoColumnas(trx, empresaId, q.hasta);
    });
  });
}
