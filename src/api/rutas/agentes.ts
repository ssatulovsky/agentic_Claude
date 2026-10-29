import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolverPropuesta } from '../../agentes/ejecutor.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

export async function rutasAgentes(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));

  /** Organigrama de agentes disponible. */
  app.get('/agentes', async () =>
    deps.registro.agentes().map((a) => ({
      codigo: a.codigo,
      cargo: a.cargo,
      descripcion: a.descripcion,
      herramientas: a.herramientas,
    })),
  );

  /** Propuestas de los agentes: el solicitante ve las suyas; quien aprueba ve todas las de la empresa. */
  app.get('/empresas/:empresaId/propuestas', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const { estado } = validar(
      z.object({ estado: z.enum(['PENDIENTE', 'APROBADA', 'RECHAZADA', 'EJECUTADA', 'FALLIDA', 'VENCIDA']).optional() }),
      req.query,
    );
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'agentes.consultar');
      let consulta = trx
        .selectFrom('propuestas_agente')
        .select([
          'id',
          'agente_codigo',
          'herramienta',
          'autonomia',
          'resumen',
          'estado',
          'solicitado_por',
          'revisado_por',
          'revisado_en',
          'motivo',
          'creado_en',
          'vence_en',
        ])
        .where('empresa_id', '=', empresaId)
        .orderBy('creado_en', 'desc')
        .limit(200);
      if (estado) consulta = consulta.where('estado', '=', estado);
      return consulta.execute();
    });
  });

  app.post('/empresas/:empresaId/propuestas/:propuestaId/resolver', async (req) => {
    const { empresaId, propuestaId } = validar(paramEmpresa.extend({ propuestaId: z.uuid() }), req.params);
    const { decision, motivo } = validar(
      z.object({ decision: z.enum(['APROBAR', 'RECHAZAR']), motivo: z.string().trim().max(500).optional() }),
      req.body,
    );
    return resolverPropuesta(
      deps.db,
      deps.registro,
      { usuarioId: req.sesion!.usuarioId, empresaId },
      propuestaId,
      decision,
      motivo ?? null,
    );
  });
}
