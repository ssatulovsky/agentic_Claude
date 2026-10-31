import { randomUUID } from 'node:crypto';
import { enContexto, type Db } from '../db/conexion.js';
import type { RegistroAgentes } from './catalogo.js';
import { ejecutarHerramienta, hoy, registrarTraza, type Solicitante } from './ejecutor.js';
import { avisoCifras, cifrasSinRespaldo } from './contralor.js';
import type { MensajeConversacion, ModeloIA } from './tipos.js';

export interface ResultadoConversacion {
  conversacionId: string;
  respuesta: string;
  mensajes: MensajeConversacion[];
  pasos: number;
  /** Cifras de la respuesta sin respaldo en los datos consultados (control del Contralor). */
  cifrasSinRespaldo: string[];
}

/**
 * Ciclo de un agente: el modelo decide qué herramientas usar, el núcleo las
 * ejecuta con los permisos de la persona, y el modelo redacta la respuesta con
 * esos resultados. Tiene un tope de pasos para no quedar en un ciclo infinito.
 */
export async function conversar(
  db: Db,
  registro: RegistroAgentes,
  modelo: ModeloIA,
  opciones: {
    agenteCodigo: string;
    solicitante: Solicitante;
    mensaje: string;
    historial?: MensajeConversacion[];
    /** Resultados de herramientas de turnos anteriores (respaldo de cifras ya consultadas). */
    fuentesPrevias?: unknown[];
    conversacionId?: string;
    fecha?: string;
    maxPasos?: number;
  },
): Promise<ResultadoConversacion> {
  const agente = registro.agente(opciones.agenteCodigo);
  if (!agente) {
    throw new Error(`Agente desconocido: ${opciones.agenteCodigo}`);
  }
  const conversacionId = opciones.conversacionId ?? randomUUID();
  const fecha = opciones.fecha ?? hoy();
  const maxPasos = opciones.maxPasos ?? 8;
  const mensajes: MensajeConversacion[] = [...(opciones.historial ?? []), { rol: 'usuario', texto: opciones.mensaje }];
  const especificaciones = registro.especificaciones(agente.codigo);
  const instrucciones = `${agente.instrucciones}\nFecha de hoy: ${fecha}.`;

  const trazar = (paso: number, tipo: 'MENSAJE_USUARIO' | 'RESPUESTA' | 'ERROR' | 'CONTROL_CIFRAS', contenido: unknown) =>
    enContexto(
      db,
      {
        usuarioId: opciones.solicitante.usuarioId,
        empresaId: opciones.solicitante.empresaId,
        actorTipo: 'AGENTE',
        actorId: agente.codigo,
      },
      (trx) =>
        registrarTraza(trx, {
          empresaId: opciones.solicitante.empresaId,
          conversacionId,
          usuarioId: opciones.solicitante.usuarioId,
          agenteCodigo: agente.codigo,
          paso,
          tipo,
          contenido,
        }),
    );

  await trazar(0, 'MENSAJE_USUARIO', { texto: opciones.mensaje });

  for (let paso = 1; paso <= maxPasos; paso++) {
    const respuesta = await modelo.responder({ instrucciones, mensajes, herramientas: especificaciones });
    if (respuesta.tipo === 'texto') {
      // Control de cifras: toda cifra debe venir de una herramienta o de lo que dijo la persona.
      // (No cuentan como fuente las respuestas anteriores del agente ni lo que él mismo puso en las herramientas.)
      const fuentes = [
        ...(opciones.fuentesPrevias ?? []),
        // Solo los datos de herramientas ejecutadas: un resumen de propuesta o un mensaje de
        // denegación repiten lo que puso el propio agente.
        ...mensajes.flatMap((m): unknown[] =>
          m.rol === 'herramienta' ? (m.resultado.estado === 'EJECUTADA' ? [m.resultado.resultado] : []) : m.rol === 'usuario' ? [m.texto] : [],
        ),
      ];
      const sinRespaldo = cifrasSinRespaldo(respuesta.texto, fuentes);
      const texto = sinRespaldo.length > 0 ? respuesta.texto + avisoCifras(sinRespaldo) : respuesta.texto;
      if (sinRespaldo.length > 0) await trazar(paso, 'CONTROL_CIFRAS', { cifrasSinRespaldo: sinRespaldo });
      mensajes.push({ rol: 'asistente', texto });
      await trazar(paso, 'RESPUESTA', { texto });
      return { conversacionId, respuesta: texto, mensajes, pasos: paso, cifrasSinRespaldo: sinRespaldo };
    }
    mensajes.push({ rol: 'asistente', llamadas: respuesta.llamadas });
    for (const llamada of respuesta.llamadas) {
      const resultado = await ejecutarHerramienta(db, registro, {
        agenteCodigo: agente.codigo,
        solicitante: opciones.solicitante,
        nombre: llamada.nombre,
        entrada: llamada.entrada,
        fecha,
        conversacionId,
        paso,
      });
      mensajes.push({ rol: 'herramienta', llamadaId: llamada.id, resultado });
    }
  }

  const aviso = 'No pude completar la consulta dentro del límite de pasos. Por favor, reformúlela o divídala.';
  await trazar(maxPasos + 1, 'ERROR', { motivo: 'LIMITE_DE_PASOS' });
  return { conversacionId, respuesta: aviso, mensajes, pasos: maxPasos, cifrasSinRespaldo: [] };
}
