import { randomUUID } from 'node:crypto';
import type { LlamadaHerramienta, ModeloIA, RespuestaModelo } from '../../agentes/tipos.js';
import { ErrorProveedor, esquemaSimple, llamarJson, type Fetch } from './comun.js';

interface Parte {
  text?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: { name: string; response: unknown; id?: string };
}

/** Gemini (API generateContent de Google) con llamadas a funciones. */
export class ModeloGemini implements ModeloIA {
  constructor(
    private readonly opciones: { apiKey: string; modelo: string; url?: string; maxTokens?: number; timeoutMs?: number; fetch?: Fetch },
  ) {}

  async responder(p: Parameters<ModeloIA['responder']>[0]): Promise<RespuestaModelo> {
    const nombrePorLlamada = new Map<string, string>();
    const contents: Array<{ role: 'user' | 'model'; parts: Parte[] }> = [];
    for (const m of p.mensajes) {
      if (m.rol === 'usuario') contents.push({ role: 'user', parts: [{ text: m.texto }] });
      else if (m.rol === 'asistente') {
        const parts: Parte[] = [];
        if (m.texto) parts.push({ text: m.texto });
        for (const l of m.llamadas ?? []) {
          nombrePorLlamada.set(l.id, l.nombre);
          parts.push({ functionCall: { name: l.nombre, args: l.entrada ?? {} } });
        }
        contents.push({ role: 'model', parts });
      } else {
        const parte: Parte = { functionResponse: { name: nombrePorLlamada.get(m.llamadaId) ?? 'herramienta', response: { resultado: m.resultado } } };
        const ultimo = contents[contents.length - 1];
        if (ultimo?.role === 'user' && ultimo.parts.every((x) => x.functionResponse)) ultimo.parts.push(parte);
        else contents.push({ role: 'user', parts: [parte] });
      }
    }
    const base = this.opciones.url ?? 'https://generativelanguage.googleapis.com/v1beta';
    const datos = (await llamarJson('GEMINI', this.opciones.fetch ?? fetch, `${base}/models/${encodeURIComponent(this.opciones.modelo)}:generateContent`, {
      headers: { 'x-goog-api-key': this.opciones.apiKey },
      timeoutMs: this.opciones.timeoutMs ?? 60_000,
      ...(p.senal ? { senal: p.senal } : {}),
      body: {
        systemInstruction: { parts: [{ text: p.instrucciones }] },
        contents,
        tools: p.herramientas.length
          ? [{ functionDeclarations: p.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: esquemaSimple(h.esquemaEntrada) })) }]
          : undefined,
        generationConfig: { maxOutputTokens: this.opciones.maxTokens ?? 2048 },
      },
    })) as {
      candidates?: Array<{ content?: { parts?: Parte[] } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const partes = datos.candidates?.[0]?.content?.parts;
    if (!Array.isArray(partes)) throw new ErrorProveedor('GEMINI', 'Respuesta sin contenido');
    const uso = { tokensEntrada: datos.usageMetadata?.promptTokenCount ?? 0, tokensSalida: datos.usageMetadata?.candidatesTokenCount ?? 0 };
    const llamadas: LlamadaHerramienta[] = partes
      .filter((x) => x.functionCall?.name)
      .map((x) => ({ id: x.functionCall!.id ?? randomUUID(), nombre: x.functionCall!.name, entrada: x.functionCall!.args ?? {} }));
    if (llamadas.length > 0) return { tipo: 'herramientas', llamadas, uso };
    return { tipo: 'texto', texto: partes.map((x) => x.text ?? '').join('\n').trim(), uso };
  }
}
