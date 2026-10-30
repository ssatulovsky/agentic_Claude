import { sql } from 'kysely';
import type { ModeloIA, RespuestaModelo } from '../agentes/tipos.js';
import type { Configuracion } from '../config.js';
import { enContexto, type Db } from '../db/conexion.js';
import { ErrorNegocio } from '../errores.js';
import { ModeloAnthropic } from './proveedores/anthropic.js';
import { ErrorProveedor, type Fetch } from './proveedores/comun.js';
import { ModeloGemini } from './proveedores/gemini.js';
import { ModeloOllama } from './proveedores/ollama.js';
import { filtrarTexto, filtrarValor } from './sensibles.js';

export interface ModeloCatalogo {
  codigo: string;
  proveedor: 'ANTHROPIC' | 'GEMINI' | 'OLLAMA';
  nombre_api: string | null;
  local: boolean;
}

/** Crea el cliente de un modelo; null si el proveedor no está configurado en este servidor. */
export type FabricaModelos = (m: ModeloCatalogo) => ModeloIA | null;

export function fabricaDesdeConfiguracion(config: Configuracion, hacerFetch?: Fetch): FabricaModelos {
  return (m) => {
    const comunes = { timeoutMs: config.IA_TIMEOUT_MS, ...(hacerFetch ? { fetch: hacerFetch } : {}) };
    switch (m.proveedor) {
      case 'ANTHROPIC':
        return config.ANTHROPIC_API_KEY ? new ModeloAnthropic({ apiKey: config.ANTHROPIC_API_KEY, modelo: m.nombre_api!, ...comunes }) : null;
      case 'GEMINI':
        return config.GEMINI_API_KEY ? new ModeloGemini({ apiKey: config.GEMINI_API_KEY, modelo: m.nombre_api!, ...comunes }) : null;
      case 'OLLAMA': {
        const modelo = m.nombre_api ?? config.OLLAMA_MODELO;
        return config.OLLAMA_URL && modelo ? new ModeloOllama({ url: config.OLLAMA_URL, modelo, ...comunes }) : null;
      }
    }
  };
}

export interface IntentoModelo {
  modelo: string;
  resultado: 'OK' | 'ERROR' | 'NO_CONFIGURADO' | 'OMITIDO_POR_CUPO' | 'OMITIDO_SIN_PRECIO';
  detalle?: string;
  datosProtegidos?: number;
}

export interface ContextoEnrutado {
  usuarioId: string;
  empresaId: string;
  agenteCodigo: string;
  conversacionId?: string;
  /** Plazo total para todas las llamadas de una conversación (todos los pasos y respaldos). */
  plazoMs?: number;
  /** Registro del servidor para el detalle técnico de los errores del proveedor (ya filtrado). */
  registrar?: (mensaje: string, datos: Record<string, unknown>) => void;
}

/**
 * Modelo "enrutado": aplica la política de IA vigente de la empresa y el agente (cadena de
 * modelos por nivel), el cupo del Cliente ERP y el filtro de datos sensibles para los modelos
 * en la nube; prueba los modelos en orden y registra cada llamada (tokens, costo, latencia).
 */
export class ModeloEnrutado implements ModeloIA {
  readonly intentos: IntentoModelo[] = [];
  private politica: { politicaId: number; modelos: ModeloCatalogo[] } | null = null;
  private readonly vence: number;

  constructor(
    private readonly db: Db,
    private readonly fabrica: FabricaModelos,
    private readonly contexto: ContextoEnrutado,
  ) {
    this.vence = Date.now() + (contexto.plazoMs ?? 120_000);
  }

  private ctx() {
    return { usuarioId: this.contexto.usuarioId, empresaId: this.contexto.empresaId, actorTipo: 'AGENTE' as const, actorId: this.contexto.agenteCodigo };
  }

  private async resolverPolitica() {
    if (this.politica) return this.politica;
    this.politica = await enContexto(this.db, this.ctx(), async (trx) => {
      const { rows: pol } = await sql<{ politica_id: string; cadena: string[] }>`
        SELECT politica_id, cadena FROM ia_politica_vigente(${this.contexto.empresaId}::uuid, ${this.contexto.agenteCodigo})`.execute(trx);
      if (!pol[0]) throw new ErrorNegocio('IA_SIN_POLITICA', 'No hay una política de IA para este agente.', 503);
      const { rows: modelos } = await sql<ModeloCatalogo>`
        SELECT codigo, proveedor, nombre_api, local FROM modelos_ia WHERE codigo = ANY (${pol[0].cadena}::text[]) AND activo`.execute(trx);
      const ordenados = pol[0].cadena.map((c) => modelos.find((m) => m.codigo === c)).filter((m): m is ModeloCatalogo => !!m);
      return { politicaId: Number(pol[0].politica_id), modelos: ordenados };
    });
    return this.politica;
  }

  /**
   * Estado del cupo, consultado en cada paso (no una sola vez por conversación). Con cupo
   * SOLO_LOCAL, un modelo en la nube sin precio vigente no se usa: su costo no se podría medir.
   */
  private async restricciones() {
    return enContexto(this.db, this.ctx(), async (trx) => {
      const { rows: cupo } = await sql<{ excedido: boolean | null; al_exceder: string | null }>`
        SELECT excedido, al_exceder FROM ia_estado_cupo(${this.contexto.empresaId}::uuid)`.execute(trx);
      const { rows: conPrecio } = await sql<{ modelo: string }>`
        SELECT modelo FROM precios_modelos_ia WHERE daterange(vigente_desde, vigente_hasta, '[)') @> contabilidad_hoy()`.execute(trx);
      const soloLocal = cupo[0]?.al_exceder === 'SOLO_LOCAL';
      return { cupoAgotado: soloLocal && cupo[0]?.excedido === true, exigePrecio: soloLocal, conPrecio: new Set(conPrecio.map((r) => r.modelo)) };
    });
  }

  private async registrarUso(modelo: string, politicaId: number, uso: { tokensEntrada: number; tokensSalida: number }, exito: boolean, error: string | null, latencia: number) {
    await enContexto(this.db, this.ctx(), (trx) =>
      sql`SELECT ia_registrar_uso(${this.contexto.empresaId}::uuid, ${this.contexto.agenteCodigo}, ${this.contexto.conversacionId ?? null}::uuid,
            ${modelo}, ${politicaId}::bigint, ${uso.tokensEntrada}::int, ${uso.tokensSalida}::int, ${exito}, ${error}, ${latencia}::int)`.execute(trx),
    );
  }

  private noDisponible(mensaje: string): never {
    throw new ErrorNegocio('IA_NO_DISPONIBLE', mensaje, 503, { intentos: this.intentos });
  }

  async responder(p: Parameters<ModeloIA['responder']>[0]): Promise<RespuestaModelo> {
    const { politicaId, modelos } = await this.resolverPolitica();
    const { cupoAgotado, exigePrecio, conPrecio } = await this.restricciones();
    for (const m of modelos) {
      if (!m.local && cupoAgotado) {
        this.intentos.push({ modelo: m.codigo, resultado: 'OMITIDO_POR_CUPO' });
        continue;
      }
      if (!m.local && exigePrecio && !conPrecio.has(m.codigo)) {
        this.intentos.push({ modelo: m.codigo, resultado: 'OMITIDO_SIN_PRECIO' });
        continue;
      }
      const cliente = this.fabrica(m);
      if (!cliente) {
        this.intentos.push({ modelo: m.codigo, resultado: 'NO_CONFIGURADO' });
        continue;
      }
      const restante = this.vence - Date.now();
      if (restante <= 0) this.noDisponible('La consulta tomó demasiado tiempo. Intente con una pregunta más acotada.');
      // A la nube nunca van contraseñas, claves tributarias, certificados ni claves de API.
      let peticion = { ...p, senal: AbortSignal.timeout(restante) };
      let protegidos = 0;
      if (!m.local) {
        const mensajes = filtrarValor(p.mensajes);
        const instrucciones = filtrarTexto(p.instrucciones);
        protegidos = mensajes.reemplazos + instrucciones.reemplazos;
        peticion = { ...peticion, mensajes: mensajes.valor, instrucciones: instrucciones.valor };
      }
      const inicio = Date.now();
      try {
        const r = await cliente.responder(peticion);
        await this.registrarUso(m.codigo, politicaId, r.uso ?? { tokensEntrada: 0, tokensSalida: 0 }, true, null, Date.now() - inicio);
        this.intentos.push({ modelo: m.codigo, resultado: 'OK', ...(protegidos ? { datosProtegidos: protegidos } : {}) });
        return r;
      } catch (e) {
        // Solo un texto genérico llega a la persona y a uso_ia; el detalle del proveedor puede
        // repetir datos de la petición y queda (filtrado) en el registro del servidor.
        const detalle = e instanceof ErrorProveedor ? e.message : 'Error inesperado del proveedor';
        const interno = e instanceof ErrorProveedor ? e.interno : (e as Error)?.message;
        if (interno) this.contexto.registrar?.('Error del proveedor de IA', { modelo: m.codigo, estado: e instanceof ErrorProveedor ? e.estado : undefined, detalle: filtrarTexto(interno).valor });
        await this.registrarUso(m.codigo, politicaId, { tokensEntrada: 0, tokensSalida: 0 }, false, detalle, Date.now() - inicio);
        this.intentos.push({ modelo: m.codigo, resultado: 'ERROR', detalle });
      }
    }
    this.noDisponible('Ningún modelo de IA pudo responder en este momento. Intente más tarde o avise al administrador.');
  }
}
