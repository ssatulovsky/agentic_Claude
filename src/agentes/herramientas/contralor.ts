import { z } from 'zod';
import type { DefinicionHerramienta } from '../tipos.js';

/** Revisiones recientes del Contralor (las que ve la persona: las suyas, o todas si aprueba propuestas). */
export const consultarRevisionesContralor: DefinicionHerramienta<{ dictamen?: 'CONFORME' | 'OBSERVADA' | 'RECHAZADA'; dias: number }, unknown> = {
  nombre: 'consultar_revisiones_contralor',
  descripcion:
    'Revisiones del Contralor a las propuestas de los agentes en los últimos días: dictamen (conforme, observada o rechazada), hallazgos y resumen de cada propuesta.',
  modulo: null,
  permiso: 'agentes.consultar',
  autonomia: 'CONSULTAR',
  entrada: z.object({
    dictamen: z.enum(['CONFORME', 'OBSERVADA', 'RECHAZADA']).optional(),
    dias: z.number().int().min(1).max(90).default(30),
  }),
  async ejecutar({ trx, seguridad }, e) {
    let consulta = trx
      .selectFrom('revisiones_contralor')
      .select(['creado_en', 'agente_codigo', 'herramienta', 'dictamen', 'hallazgos', 'resumen', 'propuesta_id'])
      .where('empresa_id', '=', seguridad.empresaId)
      .where('creado_en', '>=', new Date(Date.now() - e.dias * 86_400_000))
      .orderBy('creado_en', 'desc')
      .limit(50);
    if (e.dictamen) consulta = consulta.where('dictamen', '=', e.dictamen);
    const filas = await consulta.execute();
    return { revisiones: filas, total: filas.length };
  },
};

export const HERRAMIENTAS_CONTRALOR = [consultarRevisionesContralor] as DefinicionHerramienta[];
