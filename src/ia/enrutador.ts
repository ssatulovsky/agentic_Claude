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
  resultado: 'OK' | 'ERROR' | 'NO_CONFIGURADO' | 'OMITIDO_POR_CUPO';
  detalle?: string;
  datosProtegidos?: number;
}

/**
 * Modelo "enrutado": aplica la política de IA vigente de la empresa y el agente (cadena de
 * modelos por nivel), el cupo del Cliente ERP y el filtro de datos sensibles para los modelos
 * en la nube; prueba los modelos en orden y registra cada llamada (tokens, costo, latencia).
 */
export class ModeloEnrutado implements ModeloIA {
  readonly intentos: IntentoModelo[] = [];
  private cadena: { politicaId: number; modelos: ModeloCatalogo[] } | null = null;

  constructor(
    private readonly db: Db,
    private readonly fabrica: FabricaModelos,
    private readonly contexto: { usuarioId: string; empresaId: string; agenteCodigo: string; conversacionId?: string },
  ) {}

  private ctx() {
    return { usuarioId: this.contexto.usuarioId, empresaId: this.contexto.empresaId, actorTipo: 'AGENTE' as const, actorId: this.contexto.agenteCodigo };
  }

  private async resolverCadena() {
    if (this.cadena) return this.cadena;
    this.cadena = await enContexto(this.db, this.ctx(), async (trx) => {
      const { rows: pol } = await sql<{ politica_id: string; cadena: string[] }>`
        SELECT politica_id, cadena FROM ia_politica_vigente(${this.contexto.empresaId}::uuid, ${this.contexto.agenteCodigo})`.execute(trx);
      if (!pol[0]) throw new ErrorNegocio('IA_SIN_POLITICA', 'No hay una política de IA para este agente.', 503);
      const { rows: modelos } = await sql<ModeloCatalogo>`
        SELECT codigo, proveedor, nombre_api, local FROM modelos_ia WHERE codigo = ANY (${pol[0].cadena}::text[]) AND activo`.execute(trx);
      const { rows: cupo } = await sql<{ excedido: boolean | null; al_exceder: string | null }>`
        SELECT excedido, al_exceder FROM ia_estado_cupo(${this.contexto.empresaId}::uuid)`.execute(trx);
      const soloLocal = cupo[0]?.excedido === true && cupo[0].al_exceder === 'SOLO_LOCAL';
      const ordenados = pol[0].cadena.map((c) => modelos.find((m) => m.codigo === c)).filter((m): m is ModeloCatalogo => !!m);
      const permitidos = ordenados.filter((m) => {
        if (soloLocal && !m.local) {
          this.intentos.push({ modelo: m.codigo, resultado: 'OMITIDO_POR_CUPO' });
          return false;
        }
        return true;
      });
      return { politicaId: Number(pol[0].politica_id), modelos: permitidos };
    });
    return this.cadena;
  }

  private async registrarUso(modelo: string, politicaId: number, uso: { tokensEntrada: number; tokensSalida: number }, exito: boolean, error: string | null, latencia: number) {
    await enContexto(this.db, this.ctx(), (trx) =>
      sql`SELECT ia_registrar_uso(${this.contexto.empresaId}::uuid, ${this.contexto.agenteCodigo}, ${this.contexto.conversacionId ?? null}::uuid,
            ${modelo}, ${politicaId}::bigint, ${uso.tokensEntrada}::int, ${uso.tokensSalida}::int, ${exito}, ${error}, ${latencia}::int)`.execute(trx),
    );
  }

  async responder(p: Parameters<ModeloIA['responder']>[0]): Promise<RespuestaModelo> {
    const { politicaId, modelos } = await this.resolverCadena();
    for (const m of modelos) {
      const cliente = this.fabrica(m);
      if (!cliente) {
        this.intentos.push({ modelo: m.codigo, resultado: 'NO_CONFIGURADO' });
        continue;
      }
      // A la nube nunca van contraseñas, claves tributarias, certificados ni claves de API.
      let peticion = p;
      let protegidos = 0;
      if (!m.local) {
        const mensajes = filtrarValor(p.mensajes);
        const instrucciones = filtrarTexto(p.instrucciones);
        protegidos = mensajes.reemplazos + instrucciones.reemplazos;
        peticion = { ...p, mensajes: mensajes.valor, instrucciones: instrucciones.valor };
      }
      const inicio = Date.now();
      try {
        const r = await cliente.responder(peticion);
        await this.registrarUso(m.codigo, politicaId, r.uso ?? { tokensEntrada: 0, tokensSalida: 0 }, true, null, Date.now() - inicio);
        this.intentos.push({ modelo: m.codigo, resultado: 'OK', ...(protegidos ? { datosProtegidos: protegidos } : {}) });
        return r;
      } catch (e) {
        const detalle = e instanceof ErrorProveedor ? e.message : 'Error inesperado del proveedor';
        await this.registrarUso(m.codigo, politicaId, { tokensEntrada: 0, tokensSalida: 0 }, false, detalle, Date.now() - inicio);
        this.intentos.push({ modelo: m.codigo, resultado: 'ERROR', detalle });
      }
    }
    throw new ErrorNegocio(
      'IA_NO_DISPONIBLE',
      'Ningún modelo de IA pudo responder en este momento. Intente más tarde o avise al administrador.',
      503,
      { intentos: this.intentos },
    );
  }
}
