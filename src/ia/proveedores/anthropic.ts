import type { LlamadaHerramienta, MensajeConversacion, ModeloIA, RespuestaModelo } from '../../agentes/tipos.js';
import { ErrorProveedor, llamarJson, type Fetch } from './comun.js';

interface Bloque {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Claude (API de Mensajes de Anthropic) con uso de herramientas. */
export class ModeloAnthropic implements ModeloIA {
  constructor(
    private readonly opciones: { apiKey: string; modelo: string; url?: string; maxTokens?: number; timeoutMs?: number; fetch?: Fetch },
  ) {}

  async responder(p: Parameters<ModeloIA['responder']>[0]): Promise<RespuestaModelo> {
    const mensajes: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (const m of p.mensajes) {
      if (m.rol === 'usuario') mensajes.push({ role: 'user', content: m.texto });
      else if (m.rol === 'asistente') {
        const content: Bloque[] = [];
        if (m.texto) content.push({ type: 'text', text: m.texto });
        for (const l of m.llamadas ?? []) content.push({ type: 'tool_use', id: l.id, name: l.nombre, input: l.entrada ?? {} });
        mensajes.push({ role: 'assistant', content });
      } else {
        // Los resultados consecutivos van juntos en un solo mensaje del usuario.
        const bloque = { type: 'tool_result', tool_use_id: m.llamadaId, content: JSON.stringify(m.resultado) };
        const ultimo = mensajes[mensajes.length - 1];
        if (ultimo?.role === 'user' && Array.isArray(ultimo.content) && esResultados(p.mensajes, m)) (ultimo.content as unknown[]).push(bloque);
        else mensajes.push({ role: 'user', content: [bloque] });
      }
    }
    const datos = (await llamarJson('ANTHROPIC', this.opciones.fetch ?? fetch, this.opciones.url ?? 'https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': this.opciones.apiKey, 'anthropic-version': '2023-06-01' },
      timeoutMs: this.opciones.timeoutMs ?? 60_000,
      ...(p.senal ? { senal: p.senal } : {}),
      body: {
        model: this.opciones.modelo,
        max_tokens: this.opciones.maxTokens ?? 2048,
        system: p.instrucciones,
        messages: mensajes,
        tools: p.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquemaEntrada })),
      },
    })) as { content?: Bloque[]; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!Array.isArray(datos.content)) throw new ErrorProveedor('ANTHROPIC', 'Respuesta sin contenido');
    const uso = { tokensEntrada: datos.usage?.input_tokens ?? 0, tokensSalida: datos.usage?.output_tokens ?? 0 };
    const llamadas: LlamadaHerramienta[] = datos.content
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({ id: b.id!, nombre: b.name!, entrada: b.input ?? {} }));
    if (llamadas.length > 0) return { tipo: 'herramientas', llamadas, uso };
    const texto = datos.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    return { tipo: 'texto', texto, uso };
  }
}

/** ¿El mensaje anterior en la conversación también es un resultado de herramienta? */
function esResultados(todos: MensajeConversacion[], actual: MensajeConversacion): boolean {
  const i = todos.indexOf(actual);
  return i > 0 && todos[i - 1]!.rol === 'herramienta';
}
