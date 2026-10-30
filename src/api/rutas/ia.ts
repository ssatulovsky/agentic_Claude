import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { configurarPolitica, estadoCupo, modelosConPrecio, politicasEfectivas, reporteUso } from '../../ia/uso.js';
import { exigirPermiso, permisosEnEmpresa, tienePermisoCliente } from '../../seguridad/permisos.js';
import { sinPermiso } from '../../errores.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((f) => {
    const d = new Date(`${f}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(f);
  }, 'Fecha inexistente');

export async function rutasIa(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));

  app.get('/ia/modelos', async (req) =>
    enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId), (trx) => modelosConPrecio(trx)),
  );

  /** Consumo del Cliente ERP (o de una empresa) en un rango de fechas. */
  app.get('/ia/uso', async (req) => {
    const q = validar(z.object({ desde: fecha, hasta: fecha, empresaId: z.uuid().optional() }), req.query);
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, q.empresaId ?? null), async (trx) => {
      const deCliente = await tienePermisoCliente(trx, 'ia.uso.ver');
      if (!deCliente) {
        if (!q.empresaId) throw sinPermiso('ia.uso.ver');
        await exigirPermiso(trx, q.empresaId, 'ia.uso.ver');
      }
      return { ...(await reporteUso(trx, q)), cupo: q.empresaId ? await estadoCupo(trx, q.empresaId) : null };
    });
  });

  /** Modelos que usa cada agente en la empresa, y el estado del cupo. */
  app.get('/empresas/:empresaId/ia/politicas', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      if ((await permisosEnEmpresa(trx, empresaId)).size === 0) throw sinPermiso();
      const agentes = deps.registro.agentes().map((a) => a.codigo);
      return {
        politicas: await politicasEfectivas(trx, empresaId, agentes),
        puedeEditar: await tienePermisoCliente(trx, 'ia.politicas.editar'),
        cupo: (await tienePermisoCliente(trx, 'ia.uso.ver')) ? await estadoCupo(trx, empresaId) : null,
      };
    });
  });

  app.put('/ia/politicas', async (req) => {
    const d = validar(
      z.object({
        empresaId: z.uuid().nullable(),
        agente: z.string().regex(/^[A-Z_]{3,40}$/u).nullable(),
        cadena: z.array(z.string().regex(/^[a-z0-9][a-z0-9.:_-]{1,60}$/u)).min(1).max(5),
        motivo: z.string().trim().min(5).max(300),
      }),
      req.body,
    );
    if (d.agente && !deps.registro.agente(d.agente)) throw sinPermiso();
    const id = await enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, d.empresaId), (trx) => configurarPolitica(trx, d));
    return { id };
  });
}
