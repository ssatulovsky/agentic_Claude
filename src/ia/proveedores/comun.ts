import type { EspecificacionHerramienta } from '../../agentes/tipos.js';

/** Error de un proveedor de IA. `reintentable`: conviene probar con el siguiente modelo de la cadena. */
export class ErrorProveedor extends Error {
  constructor(
    readonly proveedor: string,
    mensaje: string,
    readonly estado?: number,
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
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number },
): Promise<unknown> {
  let r: Response;
  try {
    r = await hacerFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    throw new ErrorProveedor(proveedor, `No se pudo conectar: ${(e as Error).message}`);
  }
  const texto = await r.text();
  if (!r.ok) {
    // El mensaje del proveedor puede ser largo; nunca incluye la clave de API (va en cabeceras).
    throw new ErrorProveedor(proveedor, `HTTP ${r.status}: ${texto.slice(0, 200)}`, r.status);
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
