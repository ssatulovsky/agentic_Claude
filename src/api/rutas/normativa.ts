import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listarBitacoraEmpresa } from '../../bitacora/bitacora.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { obtenerIndicador, obtenerParametro } from '../../normativa/normativa.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD');

export async function rutasNormativaYBitacora(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));

  /** Parámetro legal vigente en una fecha, con su fuente oficial. */
  app.get('/empresas/:empresaId/normativa/parametros/:clave', async (req) => {
    const { empresaId, clave } = validar(paramEmpresa.extend({ clave: z.string().regex(/^[A-Z0-9_.]+$/u) }), req.params);
    const { fecha: f } = validar(z.object({ fecha }), req.query);
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'normativa.ver');
      return obtenerParametro(trx, clave, f);
    });
  });

  app.get('/empresas/:empresaId/normativa/indicadores/:tipo', async (req) => {
    const { empresaId, tipo } = validar(paramEmpresa.extend({ tipo: z.enum(['UF', 'UTM', 'UTA']) }), req.params);
    const { fecha: f } = validar(z.object({ fecha }), req.query);
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'normativa.ver');
      return obtenerIndicador(trx, tipo, f);
    });
  });

  app.get('/empresas/:empresaId/bitacora', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const { antesDe, limite } = validar(
      z.object({ antesDe: z.string().regex(/^\d+$/u).optional(), limite: z.coerce.number().int().min(1).max(500).optional() }),
      req.query,
    );
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'bitacora.ver');
      return listarBitacoraEmpresa(trx, empresaId, antesDe ?? null, limite ?? 100);
    });
  });
}
