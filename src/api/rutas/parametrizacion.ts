import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cargarPlanBase, configurarImputacion, historialImputacion, listarImputaciones } from '../../contabilidad/parametrizacion.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const concepto = z.string().regex(/^[A-Z_]{3,40}$/u);

export async function rutasParametrizacion(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));
  const enEmpresa = <T>(usuarioId: string, empresaId: string, fn: Parameters<typeof enContexto<T>>[2]) =>
    enContexto(deps.db, contextoDeUsuario(usuarioId, empresaId), fn);

  app.get('/empresas/:empresaId/imputaciones', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.plan_cuentas.ver');
      return listarImputaciones(trx, empresaId);
    });
  });

  app.get('/empresas/:empresaId/imputaciones/:concepto/historial', async (req) => {
    const p = validar(paramEmpresa.extend({ concepto }), req.params);
    return enEmpresa(req.sesion!.usuarioId, p.empresaId, async (trx) => {
      await exigirPermiso(trx, p.empresaId, 'contabilidad.plan_cuentas.ver');
      return historialImputacion(trx, p.empresaId, p.concepto);
    });
  });

  app.put('/empresas/:empresaId/imputaciones/:concepto', async (req) => {
    const p = validar(paramEmpresa.extend({ concepto }), req.params);
    const d = validar(
      z.object({ cuenta: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u), motivo: z.string().trim().min(5).max(300) }),
      req.body,
    );
    await enEmpresa(req.sesion!.usuarioId, p.empresaId, (trx) => configurarImputacion(trx, p.empresaId, p.concepto, d.cuenta, d.motivo));
    return { concepto: p.concepto, cuenta: d.cuenta };
  });

  app.post('/empresas/:empresaId/plan-cuentas/cargar-base', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enEmpresa(req.sesion!.usuarioId, empresaId, (trx) => cargarPlanBase(trx, empresaId));
  });
}
