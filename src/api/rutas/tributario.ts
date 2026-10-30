import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import {
  anularF29,
  aprobarF29,
  configurarTasaPpm,
  configurarTributario,
  listarF29,
  obtenerF29,
  prepararF29,
  registrarDeclaracionF29,
} from '../../tributario/f29.js';
import { importarRcv, resumenRcv } from '../../tributario/rcv.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const anio = z.number().int().min(2000).max(2100);
const mes = z.number().int().min(1).max(12);
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD');
const motivo = z.string().trim().min(10).max(500);
const periodoQuery = z.object({ anio: z.coerce.number().int().min(2000).max(2100), mes: z.coerce.number().int().min(1).max(12) });

/** 20 MB: un RCV mensual grande cabe con holgura. */
const LIMITE_ARCHIVO = 20 * 1024 * 1024;

export async function rutasTributario(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));
  const enEmpresa = <T>(usuarioId: string, empresaId: string, fn: Parameters<typeof enContexto<T>>[2]) =>
    enContexto(deps.db, contextoDeUsuario(usuarioId, empresaId), fn);

  // ---------------- RCV ----------------
  app.post('/empresas/:empresaId/rcv/importaciones', { bodyLimit: LIMITE_ARCHIVO + 64 * 1024 }, async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        libro: z.enum(['COMPRA', 'VENTA']),
        seccion: z.enum(['REGISTRO', 'PENDIENTE', 'NO_INCLUIR', 'RECLAMADO']).optional(),
        anio,
        mes,
        archivoNombre: z.string().trim().min(1).max(200),
        contenido: z.string().min(1).max(LIMITE_ARCHIVO),
      }),
      req.body,
    );
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => importarRcv(trx, { empresaId, ...d }));
    return reply.status(201).send(r);
  });

  app.get('/empresas/:empresaId/rcv', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const q = validar(periodoQuery, req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tributario.ver');
      return resumenRcv(trx, empresaId, q.anio, q.mes);
    });
  });

  // ---------------- PPM ----------------
  app.post('/empresas/:empresaId/tasas-ppm', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        desde: fecha.refine((f) => f.endsWith('-01'), 'Debe ser el primer día del mes'),
        tasa: z.number().min(0).max(25),
        fuente: z.string().trim().min(5).max(300),
        motivoReemplazo: z.string().trim().min(10).max(500).optional(),
      }),
      req.body,
    );
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => configurarTasaPpm(trx, empresaId, d.desde, d.tasa, d.fuente, d.motivoReemplazo));
    return reply.status(201).send({ desde: d.desde, tasa: d.tasa });
  });

  // ---------------- Configuración tributaria ----------------
  app.post('/empresas/:empresaId/configuracion-tributaria', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        desde: fecha.refine((f) => f.endsWith('-01'), 'Debe ser el primer día del mes'),
        regimen: z.enum(['PRO_PYME_TRANSPARENTE', 'PRO_PYME_GENERAL', 'SEMI_INTEGRADO', 'OTRO']),
        ivaComprasNoRecuperable: z.boolean(),
        codigoIvaNoRecuperable: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(9)]).optional(),
        motivo: z.string().trim().min(10).max(500),
      }),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => configurarTributario(trx, { empresaId, ...d }));
    return reply.status(201).send({ id });
  });

  // ---------------- F29 ----------------
  app.post('/empresas/:empresaId/f29', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        anio,
        mes,
        remanenteAnterior: z.number().int().nonnegative().max(999_999_999_999).optional(),
        factorProporcionalidad: z.number().min(0).max(1).optional(),
        ajustes: z
          .array(
            z.object({
              codigo: z.string().regex(/^\d{1,4}$/u),
              monto: z.number().int().refine((n) => n !== 0, 'El ajuste no puede ser cero'),
              motivo,
            }),
          )
          .max(50)
          .optional(),
      }),
      req.body,
    );
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      const id = await prepararF29(trx, { empresaId, ...d });
      return obtenerF29(trx, empresaId, id);
    });
    return reply.status(201).send(r);
  });

  app.get('/empresas/:empresaId/f29', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const q = validar(periodoQuery.partial(), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tributario.ver');
      return listarF29(trx, empresaId, q.anio, q.mes);
    });
  });

  app.get('/empresas/:empresaId/f29/:f29Id', async (req) => {
    const { empresaId, f29Id } = validar(paramEmpresa.extend({ f29Id: z.uuid() }), req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tributario.ver');
      return obtenerF29(trx, empresaId, f29Id);
    });
  });

  app.post('/empresas/:empresaId/f29/:f29Id/aprobar', async (req) => {
    const { empresaId, f29Id } = validar(paramEmpresa.extend({ f29Id: z.uuid() }), req.params);
    const d = validar(z.object({ confirmoAdvertencias: z.boolean().optional() }), req.body ?? {});
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => aprobarF29(trx, f29Id, d.confirmoAdvertencias === true));
    return { estado: 'APROBADA' };
  });

  app.post('/empresas/:empresaId/f29/:f29Id/declaracion', async (req) => {
    const { empresaId, f29Id } = validar(paramEmpresa.extend({ f29Id: z.uuid() }), req.params);
    const d = validar(z.object({ folio: z.string().regex(/^\d{1,20}$/u), fecha }), req.body);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => registrarDeclaracionF29(trx, f29Id, d.folio, d.fecha));
    return { estado: 'DECLARADA' };
  });

  app.post('/empresas/:empresaId/f29/:f29Id/anular', async (req) => {
    const { empresaId, f29Id } = validar(paramEmpresa.extend({ f29Id: z.uuid() }), req.params);
    const d = validar(z.object({ motivo }), req.body);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => anularF29(trx, f29Id, d.motivo));
    return { estado: 'ANULADA' };
  });
}
