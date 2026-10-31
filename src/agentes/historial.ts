import { sql } from 'kysely';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio } from '../errores.js';
import type { MensajeConversacion } from './tipos.js';

/**
 * Historial (solo textos) de una conversación para retomarla en cualquier canal.
 * Una conversación es de quien la inició: se verifica sin RLS, sobre todas sus trazas.
 */
export async function historialConversacion(trx: Trx, empresaId: string, conversacionId: string): Promise<MensajeConversacion[]> {
  const { rows: ajena } = await sql<{ ajena: boolean }>`
    SELECT ia_conversacion_ajena(${empresaId}::uuid, ${conversacionId}::uuid) AS ajena`.execute(trx);
  if (ajena[0]?.ajena !== false) throw new ErrorNegocio('NO_ENCONTRADO', 'La conversación no existe.', 404);
  const { rows } = await sql<{ tipo: string; texto: string | null }>`
    SELECT tipo, contenido ->> 'texto' AS texto FROM trazas_agente
    WHERE conversacion_id = ${conversacionId}::uuid AND empresa_id = ${empresaId}::uuid
      AND tipo IN ('MENSAJE_USUARIO', 'RESPUESTA')
    ORDER BY creado_en DESC, paso DESC LIMIT 20`.execute(trx);
  return rows
    .reverse()
    .filter((r) => r.texto)
    .map((r): MensajeConversacion => (r.tipo === 'MENSAJE_USUARIO' ? { rol: 'usuario', texto: r.texto! } : { rol: 'asistente', texto: r.texto! }));
}

/**
 * Resultados de herramientas de turnos anteriores de una conversación (llamar después de
 * historialConversacion, que verifica que sea de quien pregunta). Respaldan las cifras que el
 * agente repite sin volver a consultar.
 */
export async function fuentesDeConversacion(trx: Trx, empresaId: string, conversacionId: string): Promise<unknown[]> {
  const { rows } = await sql<{ resultado: unknown }>`
    SELECT contenido -> 'resultado' AS resultado FROM trazas_agente
    WHERE conversacion_id = ${conversacionId}::uuid AND empresa_id = ${empresaId}::uuid AND tipo = 'RESULTADO_HERRAMIENTA'
    ORDER BY creado_en DESC, paso DESC LIMIT 50`.execute(trx);
  return rows.map((r) => r.resultado);
}
