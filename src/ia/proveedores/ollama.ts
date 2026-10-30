import { randomUUID } from 'node:crypto';
import type { LlamadaHerramienta, ModeloIA, RespuestaModelo } from '../../agentes/tipos.js';
import { ErrorProveedor, llamarJson, type Fetch } from './comun.js';

/** Modelo local servido por Ollama (/api/chat) con herramientas. Los datos no salen del servidor. */
export class ModeloOllama implements ModeloIA {
  constructor(private readonly opciones: { url: string; modelo: string; timeoutMs?: number; fetch?: Fetch }) {}

  async responder(p: Parameters<ModeloIA['responder']>[0]): Promise<RespuestaModelo> {
    const nombrePorLlamada = new Map<string, string>();
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: p.instrucciones }];
    for (const m of p.mensajes) {
      if (m.rol === 'usuario') messages.push({ role: 'user', content: m.texto });
      else if (m.rol === 'asistente') {
        for (const l of m.llamadas ?? []) nombrePorLlamada.set(l.id, l.nombre);
        messages.push({
          role: 'assistant',
          content: m.texto ?? '',
          ...(m.llamadas?.length ? { tool_calls: m.llamadas.map((l) => ({ function: { name: l.nombre, arguments: l.entrada ?? {} } })) } : {}),
        });
      } else {
        messages.push({ role: 'tool', tool_name: nombrePorLlamada.get(m.llamadaId), content: JSON.stringify(m.resultado) });
      }
    }
    const datos = (await llamarJson('OLLAMA', this.opciones.fetch ?? fetch, `${this.opciones.url.replace(/\/$/u, '')}/api/chat`, {
      headers: {},
      timeoutMs: this.opciones.timeoutMs ?? 120_000,
      ...(p.senal ? { senal: p.senal } : {}),
      body: {
        model: this.opciones.modelo,
        stream: false,
        messages,
        tools: p.herramientas.map((h) => ({ type: 'function', function: { name: h.nombre, description: h.descripcion, parameters: h.esquemaEntrada } })),
      },
    })) as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (!datos.message) throw new ErrorProveedor('OLLAMA', 'Respuesta sin mensaje');
    const uso = { tokensEntrada: datos.prompt_eval_count ?? 0, tokensSalida: datos.eval_count ?? 0 };
    const llamadas: LlamadaHerramienta[] = (datos.message.tool_calls ?? [])
      .filter((t) => t.function?.name)
      .map((t) => ({ id: randomUUID(), nombre: t.function!.name!, entrada: t.function!.arguments ?? {} }));
    if (llamadas.length > 0) return { tipo: 'herramientas', llamadas, uso };
    return { tipo: 'texto', texto: (datos.message.content ?? '').trim(), uso };
  }
}
