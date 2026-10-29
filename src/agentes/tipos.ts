import type { z } from 'zod';
import type { ContextoSeguridad, Trx } from '../db/conexion.js';

/**
 * Niveles de autonomía de una herramienta:
 *  - CONSULTAR: lee y responde. Se ejecuta de inmediato.
 *  - PROPONER: deja una propuesta que una persona aprueba antes de ejecutarse.
 *  - EJECUTAR_CON_AVISO: acción reversible; se ejecuta solo si la empresa lo autorizó
 *    para ese agente; si no, queda como propuesta.
 *  - EJECUTAR_CON_APROBACION: acción irreversible; siempre requiere aprobación humana.
 */
export type Autonomia = 'CONSULTAR' | 'PROPONER' | 'EJECUTAR_CON_AVISO' | 'EJECUTAR_CON_APROBACION';

export interface ContextoHerramienta {
  trx: Trx;
  /** Contexto de seguridad de la transacción (empresa, usuario y actor). */
  seguridad: ContextoSeguridad & { empresaId: string };
  agenteCodigo: string;
  /** Fecha de referencia para reglas con vigencia (AAAA-MM-DD). */
  fecha: string;
}

export interface DefinicionHerramienta<E = unknown, S = unknown> {
  nombre: string;
  descripcion: string;
  /** Módulo que debe estar contratado por la empresa. null = no depende de un módulo. */
  modulo: string | null;
  /** Permiso que debe tener la PERSONA que hace la consulta. */
  permiso: string;
  autonomia: Autonomia;
  entrada: z.ZodType<E>;
  ejecutar: (ctx: ContextoHerramienta, entrada: E) => Promise<S>;
  /** Texto breve para la persona que debe aprobar una propuesta. */
  resumir?: (entrada: E) => string;
}

export interface DefinicionAgente {
  codigo: string;
  cargo: string;
  descripcion: string;
  /** Instrucciones de sistema para el modelo de lenguaje. */
  instrucciones: string;
  herramientas: string[];
}

export type ResultadoHerramienta =
  | { estado: 'EJECUTADA'; resultado: unknown }
  | { estado: 'PROPUESTA_CREADA'; propuestaId: string; resumen: string }
  | { estado: 'DENEGADA'; motivo: MotivoDenegacion; mensaje: string };

export type MotivoDenegacion =
  | 'HERRAMIENTA_DESCONOCIDA'
  | 'HERRAMIENTA_NO_ASIGNADA'
  | 'ENTRADA_INVALIDA'
  | 'MODULO_NO_CONTRATADO'
  | 'AGENTE_DESACTIVADO'
  | 'SIN_PERMISO'
  | 'ERROR_NEGOCIO';

// ---------------------------------------------------------------------------
// Interfaz con el modelo de lenguaje (independiente del proveedor)
// ---------------------------------------------------------------------------

export interface EspecificacionHerramienta {
  nombre: string;
  descripcion: string;
  esquemaEntrada: Record<string, unknown>;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  entrada: unknown;
}

export type MensajeConversacion =
  | { rol: 'usuario'; texto: string }
  | { rol: 'asistente'; texto?: string; llamadas?: LlamadaHerramienta[] }
  | { rol: 'herramienta'; llamadaId: string; resultado: ResultadoHerramienta };

export type RespuestaModelo = { tipo: 'texto'; texto: string } | { tipo: 'herramientas'; llamadas: LlamadaHerramienta[] };

/** Cualquier proveedor (Claude, Gemini, un modelo local) se conecta implementando esta interfaz. */
export interface ModeloIA {
  responder(peticion: {
    instrucciones: string;
    mensajes: MensajeConversacion[];
    herramientas: EspecificacionHerramienta[];
  }): Promise<RespuestaModelo>;
}
