import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { conversar } from '../../agentes/conversacion.js';
import { resolverPropuesta } from '../../agentes/ejecutor.js';
import type { MensajeConversacion } from '../../agentes/tipos.js';
import { ModeloEnrutado } from '../../ia/enrutador.js';
import { contieneCredenciales } from '../../ia/sensibles.js';
import { ErrorNegocio } from '../../errores.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

/**
 * Límites de uso de los agentes por persona y por empresa (en memoria de este proceso): cada
 * consulta puede encadenar varios pasos y modelos, con costo en la nube.
 */
const LIMITES = { porMinutoUsuario: 10, simultaneasUsuario: 2, simultaneasEmpresa: 6 };
const minutoUsuario = new Map<string, number[]>();
const activasUsuario = new Map<string, number>();
const activasEmpresa = new Map<string, number>();

export function ocuparConsulta(usuarioId: string, empresaId: string): () => void {
  const ahora = Date.now();
  const recientes = (minutoUsuario.get(usuarioId) ?? []).filter((t) => ahora - t < 60_000);
  if (recientes.length >= LIMITES.porMinutoUsuario) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'Hizo muchas consultas seguidas. Espere un minuto e intente de nuevo.', 429);
  }
  if ((activasUsuario.get(usuarioId) ?? 0) >= LIMITES.simultaneasUsuario) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'Ya tiene consultas en curso. Espere a que terminen.', 429);
  }
  if ((activasEmpresa.get(empresaId) ?? 0) >= LIMITES.simultaneasEmpresa) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'La empresa tiene muchas consultas en curso. Intente en unos segundos.', 429);
  }
  recientes.push(ahora);
  minutoUsuario.set(usuarioId, recientes);
  activasUsuario.set(usuarioId, (activasUsuario.get(usuarioId) ?? 0) + 1);
  activasEmpresa.set(empresaId, (activasEmpresa.get(empresaId) ?? 0) + 1);
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    const u = (activasUsuario.get(usuarioId) ?? 1) - 1;
    if (u > 0) activasUsuario.set(usuarioId, u);
    else activasUsuario.delete(usuarioId);
    const e = (activasEmpresa.get(empresaId) ?? 1) - 1;
    if (e > 0) activasEmpresa.set(empresaId, e);
    else activasEmpresa.delete(empresaId);
  };
}

export async function rutasAgentes(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));

  /**
   * Conversación con un agente. El agente actúa con la identidad y los permisos de quien
   * pregunta; el modelo de IA sale de la política vigente (empresa, Cliente ERP o plataforma).
   * El historial se reconstruye desde las trazas de la conversación (solo textos).
   */
  app.post(
    '/empresas/:empresaId/agentes/:agente/conversar',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { empresaId, agente } = validar(paramEmpresa.extend({ agente: z.string().regex(/^[A-Z_]{3,40}$/u) }), req.params);
      const d = validar(z.object({ mensaje: z.string().trim().min(1).max(4000), conversacionId: z.uuid().optional() }), req.body);
      const usuarioId = req.sesion!.usuarioId;
      if (!deps.registro.agente(agente)) throw new ErrorNegocio('NO_ENCONTRADO', 'El agente no existe.', 404);
      // Ninguna contraseña, clave o certificado se envía a un modelo de IA (ni local) ni se guarda.
      if (contieneCredenciales(d.mensaje)) {
        throw new ErrorNegocio(
          'CREDENCIALES_EN_MENSAJE',
          'Su mensaje parece incluir una contraseña, clave o código de acceso, y no se envió. Los agentes nunca necesitan sus claves: escriba la consulta sin ellas.',
          422,
        );
      }
      const conversacionId = d.conversacionId ?? crypto.randomUUID();
      const historial = await enContexto(deps.db, contextoDeUsuario(usuarioId, empresaId), async (trx) => {
        await exigirPermiso(trx, empresaId, 'agentes.consultar');
        if (!d.conversacionId) return [] as MensajeConversacion[];
        // Una conversación es de quien la inició (se verifica sin RLS, sobre todas sus trazas).
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
      });
      const liberar = ocuparConsulta(usuarioId, empresaId);
      const modelo = new ModeloEnrutado(deps.db, deps.fabricaModelos!, {
        usuarioId,
        empresaId,
        agenteCodigo: agente,
        conversacionId,
        plazoMs: deps.config.IA_PLAZO_CONVERSACION_MS,
        registrar: (mensaje, datos) => req.log.warn(datos, mensaje),
      });
      const r = await conversar(deps.db, deps.registro, modelo, {
        agenteCodigo: agente,
        solicitante: { usuarioId, empresaId },
        mensaje: d.mensaje,
        historial,
        conversacionId,
      }).finally(liberar);
      return { conversacionId, respuesta: r.respuesta, pasos: r.pasos, modelos: modelo.intentos };
    },
  );

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
