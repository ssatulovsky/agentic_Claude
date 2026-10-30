import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import {
  anularConciliacion,
  conciliar,
  contabilizarMovimiento,
  crearCuentaBancaria,
  crearRegla,
  desactivarRegla,
  importarCartola,
  informeConciliacion,
  listarCuentasBancarias,
  listarMovimientos,
  listarReglas,
  sugerirConciliacion,
} from '../../tesoreria/conciliacion.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD')
  .refine((f) => {
    const d = new Date(`${f}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(f);
  }, 'Fecha inexistente');
const motivo = z.string().trim().min(10).max(500);
const cuentaContable = z.string().regex(/^[0-9]+(\.[0-9]+)*$/u);
const rut = z.string().trim().regex(/^\d{1,8}-[\dkK]$/u);
/** 10 MB de cartola, en base64. */
const LIMITE = 14 * 1024 * 1024;

export async function rutasTesoreria(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));
  // Se arma aquí (no al cargar el módulo) por la importación circular con servidor.ts.
  const paramCuenta = paramEmpresa.extend({ cuentaId: z.uuid() });
  const enEmpresa = <T>(usuarioId: string, empresaId: string, fn: Parameters<typeof enContexto<T>>[2]) =>
    enContexto(deps.db, contextoDeUsuario(usuarioId, empresaId), fn);

  app.get('/empresas/:empresaId/cuentas-bancarias', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tesoreria.saldos.ver');
      return listarCuentasBancarias(trx, empresaId);
    });
  });

  app.post('/empresas/:empresaId/cuentas-bancarias', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        banco: z.enum(['SCOTIABANK', 'BANCO_ESTADO', 'BANCO_CHILE', 'BCI', 'SANTANDER', 'ITAU', 'BICE', 'SECURITY', 'FALABELLA', 'OTRO']),
        numero: z.string().trim().min(4).max(30),
        cuentaContable,
      }),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => crearCuentaBancaria(trx, { empresaId, ...d }));
    return reply.status(201).send({ id });
  });

  app.post('/empresas/:empresaId/cuentas-bancarias/:cuentaId/cartolas', { bodyLimit: LIMITE }, async (req, reply) => {
    const { empresaId, cuentaId } = validar(paramCuenta, req.params);
    const d = validar(
      z.object({ archivoNombre: z.string().trim().min(1).max(200), contenidoBase64: z.base64().max(LIMITE - 1024) }),
      req.body,
    );
    const contenido = Buffer.from(d.contenidoBase64, 'base64');
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) =>
      importarCartola(trx, { empresaId, cuentaId, archivoNombre: d.archivoNombre, contenido }),
    );
    return reply.status(201).send(r);
  });

  app.get('/empresas/:empresaId/cuentas-bancarias/:cuentaId/movimientos', async (req) => {
    const { empresaId, cuentaId } = validar(paramCuenta, req.params);
    const q = validar(z.object({ desde: fecha.optional(), hasta: fecha.optional(), pendientes: z.enum(['si', 'no']).optional() }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tesoreria.saldos.ver');
      return listarMovimientos(trx, empresaId, cuentaId, { desde: q.desde, hasta: q.hasta, soloPendientes: q.pendientes === 'si' });
    });
  });

  app.get('/empresas/:empresaId/cuentas-bancarias/:cuentaId/sugerencias', async (req) => {
    const { empresaId, cuentaId } = validar(paramCuenta, req.params);
    const q = validar(z.object({ hasta: fecha }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => sugerirConciliacion(trx, empresaId, cuentaId, q.hasta));
  });

  app.get('/empresas/:empresaId/cuentas-bancarias/:cuentaId/conciliacion', async (req) => {
    const { empresaId, cuentaId } = validar(paramCuenta, req.params);
    const q = validar(z.object({ corte: fecha }), req.query);
    return enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => informeConciliacion(trx, empresaId, cuentaId, q.corte));
  });

  app.post('/empresas/:empresaId/conciliaciones', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z.object({
        movimientos: z.array(z.number().int().positive()).min(1).max(500),
        lineas: z.array(z.number().int().positive()).min(1).max(500),
      }),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => conciliar(trx, empresaId, d.movimientos, d.lineas));
    return reply.status(201).send({ id });
  });

  app.post('/empresas/:empresaId/conciliaciones/:conciliacionId/anular', async (req) => {
    const { empresaId, conciliacionId } = validar(paramEmpresa.extend({ conciliacionId: z.uuid() }), req.params);
    const d = validar(z.object({ motivo }), req.body);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => anularConciliacion(trx, conciliacionId, d.motivo));
    return { estado: 'ANULADA' };
  });

  app.post('/empresas/:empresaId/movimientos-bancarios/:movimientoId/contabilizar', async (req, reply) => {
    const { empresaId, movimientoId } = validar(paramEmpresa.extend({ movimientoId: z.coerce.number().int().positive() }), req.params);
    const d = validar(
      z.object({
        cuentaContable,
        tercero: rut.optional(),
        centroCosto: z.string().trim().max(20).optional(),
        glosa: z.string().trim().min(5).max(300),
      }),
      req.body,
    );
    const r = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => contabilizarMovimiento(trx, { empresaId, movimientoId, ...d }));
    return reply.status(201).send(r);
  });

  app.get('/empresas/:empresaId/reglas-conciliacion', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'tesoreria.saldos.ver');
      return listarReglas(trx, empresaId);
    });
  });

  app.post('/empresas/:empresaId/reglas-conciliacion', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(
      z
        .object({
          cuentaId: z.uuid().optional(),
          nombre: z.string().trim().min(3).max(100),
          rut: rut.optional(),
          texto: z.string().trim().min(3).max(100).optional(),
          sentido: z.enum(['ABONO', 'CARGO', 'AMBOS']),
          // Cuenta contable o concepto de imputación (se recomienda el concepto).
          destino: z.union([cuentaContable, z.string().regex(/^[A-Z_]{3,40}$/u)]),
          tercero: rut.optional(),
          glosa: z.string().trim().min(3).max(300),
        })
        .refine((r) => r.rut || r.texto, 'Indique el RUT de la contraparte o un texto de la descripción'),
      req.body,
    );
    const id = await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => crearRegla(trx, { empresaId, ...d }));
    return reply.status(201).send({ id });
  });

  app.post('/empresas/:empresaId/reglas-conciliacion/:reglaId/desactivar', async (req) => {
    const { empresaId, reglaId } = validar(paramEmpresa.extend({ reglaId: z.uuid() }), req.params);
    await enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => desactivarRegla(trx, reglaId));
    return { activa: false };
  });
}
