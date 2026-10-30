import type { EspecificacionHerramienta } from '../../agentes/tipos.js';

/**
 * Error de un proveedor de IA. `message` es apto para mostrar (sin el texto del proveedor, que
 * puede repetir datos de la petición); `interno` queda solo para los registros del servidor.
 */
export class ErrorProveedor extends Error {
  constructor(
    readonly proveedor: string,
    mensaje: string,
    readonly estado?: number,
    readonly interno?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorProveedor';
  }
}

export type Fetch = typeof fetch;

export async function llamarJson(
  proveedor: string,
  hacerFetch: Fetch,
  url: string,
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number; senal?: AbortSignal },
): Promise<unknown> {
  let r: Response;
  try {
    r = await hacerFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: init.senal ? AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.senal]) : AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    const plazo = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    throw new ErrorProveedor(proveedor, plazo ? 'Tiempo de espera agotado' : 'No se pudo conectar', undefined, (e as Error).message);
  }
  const texto = await r.text();
  if (!r.ok) {
    // El mensaje del proveedor puede ser largo; nunca incluye la clave de API (va en cabeceras).
    throw new ErrorProveedor(proveedor, `El proveedor respondió con error (HTTP ${r.status})`, r.status, texto.slice(0, 500));
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    throw new ErrorProveedor(proveedor, 'Respuesta que no es JSON');
  }
}

/** Esquema JSON sin las claves que algunos proveedores no aceptan. */
export function esquemaSimple(esquema: Record<string, unknown>): Record<string, unknown> {
  const limpiar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(limpiar);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !['$schema', 'additionalProperties', '$id', '$defs'].includes(k))
          .map(([k, x]) => [k, limpiar(x)]),
      );
    }
    return v;
  };
  return limpiar(esquema) as Record<string, unknown>;
}

export const nombresHerramientas = (h: EspecificacionHerramienta[]) => new Set(h.map((x) => x.nombre));
