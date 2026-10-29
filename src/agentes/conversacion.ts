import { randomUUID } from 'node:crypto';
import { enContexto, type Db } from '../db/conexion.js';
import type { RegistroAgentes } from './catalogo.js';
import { ejecutarHerramienta, registrarTraza, type Solicitante } from './ejecutor.js';
import type { MensajeConversacion, ModeloIA } from './tipos.js';

export interface ResultadoConversacion {
  conversacionId: string;
  respuesta: string;
  mensajes: MensajeConversacion[];
  pasos: number;
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
  const fecha = opciones.fecha ?? new Date().toISOString().slice(0, 10);
  const maxPasos = opciones.maxPasos ?? 8;
  const mensajes: MensajeConversacion[] = [...(opciones.historial ?? []), { rol: 'usuario', texto: opciones.mensaje }];
  const especificaciones = registro.especificaciones(agente.codigo);
  const instrucciones = `${agente.instrucciones}\nFecha de hoy: ${fecha}.`;

  const trazar = (paso: number, tipo: 'MENSAJE_USUARIO' | 'RESPUESTA' | 'ERROR', contenido: unknown) =>
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
      mensajes.push({ rol: 'asistente', texto: respuesta.texto });
      await trazar(paso, 'RESPUESTA', { texto: respuesta.texto });
      return { conversacionId, respuesta: respuesta.texto, mensajes, pasos: paso };
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
  return { conversacionId, respuesta: aviso, mensajes, pasos: maxPasos };
}
