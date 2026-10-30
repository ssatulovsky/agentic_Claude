import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { CABECERA_FIRMA, CABECERA_MARCA, firmaValida } from '../../canales/whatsapp/firma.js';
import { generarCodigo, hashCodigo, type ServicioWhatsapp } from '../../canales/whatsapp/servicio.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { ErrorNegocio } from '../../errores.js';
import { exigirSesion, validar, type Dependencias } from '../servidor.js';

const telefono = z.string().regex(/^\+[1-9]\d{7,14}$/u);
const mensaje = z.discriminatedUnion('tipo', [
  z.object({ id: z.string().min(1).max(200), de: telefono, tipo: z.literal('TEXTO'), texto: z.string().max(8000), esGrupo: z.boolean().optional() }),
  z.object({
    id: z.string().min(1).max(200),
    de: telefono,
    tipo: z.literal('AUDIO'),
    audio: z.object({ base64: z.string().min(1).max(12_000_000), mime: z.string().min(3).max(100) }),
    esGrupo: z.boolean().optional(),
  }),
]);

declare module 'fastify' {
  interface FastifyRequest {
    cuerpoCrudo?: string;
  }
}

const noConfigurado = () => new ErrorNegocio('CANAL_NO_CONFIGURADO', 'El canal WhatsApp no está configurado en este servidor.', 404);

/**
 * Canal WhatsApp.
 *  - Puente (conector web de WhatsApp) → ERP: mensajes entrantes y latidos, firmados con HMAC.
 *  - Persona (web, con doble factor): vincular y desvincular su WhatsApp.
 *  - Administración: estado de la conexión.
 */
export async function rutasWhatsapp(app: FastifyInstance, deps: Dependencias, servicio: ServicioWhatsapp | null): Promise<void> {
  // Rutas del puente: sin sesión; cuerpo crudo para verificar la firma.
  await app.register(async (puente) => {
    puente.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 * 1024 }, (req, cuerpo, listo) => {
      (req as FastifyRequest).cuerpoCrudo = cuerpo as string;
      try {
        listo(null, JSON.parse(cuerpo as string) as unknown);
      } catch {
        listo(new ErrorNegocio('DATOS_INVALIDOS', 'JSON inválido.', 400), undefined);
      }
    });
    puente.addHook('preHandler', async (req) => {
      const secreto = deps.config.WHATSAPP_PUENTE_SECRETO;
      if (!servicio || !secreto) throw noConfigurado();
      const marca = req.headers[CABECERA_MARCA];
      const firma = req.headers[CABECERA_FIRMA];
      if (!firmaValida(secreto, typeof marca === 'string' ? marca : undefined, typeof firma === 'string' ? firma : undefined, req.cuerpoCrudo ?? '')) {
        throw new ErrorNegocio('FIRMA_INVALIDA', 'Firma inválida.', 401);
      }
    });

    puente.post('/canales/whatsapp/mensajes', { bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const m = validar(mensaje, req.body);
      // Solo conversaciones directas: los grupos no se atienden.
      if (m.esGrupo) return reply.status(202).send({ aceptado: false, motivo: 'GRUPO' });
      const nuevo = await servicio!.recibir(m.tipo === 'TEXTO' ? { id: m.id, de: m.de, tipo: 'TEXTO', texto: m.texto } : { id: m.id, de: m.de, tipo: 'AUDIO', audio: m.audio });
      return reply.status(202).send({ aceptado: nuevo, ...(nuevo ? {} : { motivo: 'DUPLICADO' }) });
    });

    puente.post('/canales/whatsapp/latido', async (req) => {
      const d = validar(z.object({ estado: z.enum(['CONECTADO', 'DESCONECTADO']), detalle: z.string().max(300).optional() }), req.body);
      await servicio!.latido(d.estado, d.detalle ?? null);
      return { registrado: true };
    });
  });

  // Rutas de la persona y de administración: con sesión y doble factor.
  await app.register(async (web) => {
    web.addHook('preHandler', exigirSesion(deps));

    web.get('/yo/whatsapp', async (req) =>
      enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId), async (trx) => {
        const { rows } = await sql<{ telefono: string; estado: string; verificado_en: Date | null; vence_en: Date | null; codigo_vence_en: Date | null }>`
          SELECT * FROM whatsapp_mi_vinculo()`.execute(trx);
        const { rows: u } = await sql<{ telefono_whatsapp: string | null }>`
          SELECT telefono_whatsapp FROM usuarios WHERE id = ${req.sesion!.usuarioId}::uuid`.execute(trx);
        return {
          canalConfigurado: !!servicio,
          numeroErp: servicio ? (deps.config.WHATSAPP_NUMERO ?? null) : null,
          telefonoRegistrado: u[0]?.telefono_whatsapp ?? null,
          vinculo: rows[0] ?? null,
        };
      }),
    );

    web.post('/yo/whatsapp/vincular', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
      if (!servicio || !deps.config.WHATSAPP_PUENTE_SECRETO) throw noConfigurado();
      const codigo = generarCodigo();
      const tel = await enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId), async (trx) => {
        const { rows } = await sql<{ t: string }>`SELECT whatsapp_iniciar_vinculo(${hashCodigo(deps.config.WHATSAPP_PUENTE_SECRETO!, codigo)}) AS t`.execute(trx);
        return rows[0]!.t;
      });
      return {
        codigo,
        telefono: tel,
        numeroErp: deps.config.WHATSAPP_NUMERO ?? null,
        instruccion: `Desde ${tel}, envíe por WhatsApp el mensaje: VINCULAR ${codigo}`,
        venceEnMinutos: 10,
      };
    });

    web.post('/yo/whatsapp/desvincular', async (req) => {
      await enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId), (trx) => sql`SELECT whatsapp_desvincular()`.execute(trx));
      return { desvinculado: true };
    });

    web.get('/canales/whatsapp/estado', async (req) =>
      enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId), async (trx) => {
        const { rows } = await sql<{ estado: string; detalle: string | null; ultimo_latido: Date | null; cambiado_en: Date }>`
          SELECT * FROM whatsapp_estado_canal()`.execute(trx);
        if (!rows[0]) throw new ErrorNegocio('SIN_PERMISO', 'No tiene el permiso usuarios.administrar.', 403);
        return { configurado: !!servicio, ...rows[0] };
      }),
    );
  });
}
