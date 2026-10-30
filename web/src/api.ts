/** Cliente de la API: misma sesión (cookie), JSON y la cabecera anti-CSRF del servidor. */

export class ErrorApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

async function pedir<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const cabeceras: Record<string, string> = {};
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
  else if (metodo !== 'GET') cabeceras['X-ERP-Solicitud'] = '1';
  const r = await fetch(`/api${ruta}`, {
    method: metodo,
    headers: cabeceras,
    credentials: 'same-origin',
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const datos = (await r.json().catch(() => ({}))) as { error?: { codigo: string; mensaje: string; detalle?: unknown } };
  if (r.status === 401 && ruta !== '/yo' && !ruta.startsWith('/auth/')) {
    // La sesión expiró: la aplicación vuelve a la pantalla de ingreso.
    window.dispatchEvent(new Event('erp:sesion-expirada'));
  }
  if (!r.ok) {
    throw new ErrorApi(r.status, datos.error?.codigo ?? 'ERROR', mensajeConDetalle(datos.error?.mensaje ?? 'Ocurrió un error.', datos.error?.detalle));
  }
  return datos as T;
}

/** Agrega al mensaje los campos que fallaron, cuando el servidor los informa. */
function mensajeConDetalle(mensaje: string, detalle: unknown): string {
  if (!Array.isArray(detalle)) return mensaje;
  const partes = detalle
    .map((d) => (typeof d === 'object' && d && 'mensaje' in d ? `${String((d as { campo?: unknown }).campo ?? '')}: ${String((d as { mensaje: unknown }).mensaje)}` : null))
    .filter((x): x is string => x !== null)
    .slice(0, 3);
  return partes.length ? `${mensaje} (${partes.join('; ')})` : mensaje;
}

export const api = {
  get: <T>(ruta: string) => pedir<T>('GET', ruta),
  post: <T>(ruta: string, cuerpo?: unknown) => pedir<T>('POST', ruta, cuerpo),
  put: <T>(ruta: string, cuerpo: unknown) => pedir<T>('PUT', ruta, cuerpo),
};

export interface Empresa {
  id: string;
  rut: string;
  razon_social: string;
  tipo: string;
  estado: string;
}

export interface Yo {
  usuario: { id: string; email: string; nombre: string };
  empresas: Empresa[];
}

export interface Imputacion {
  concepto: string;
  nombre: string;
  descripcion: string;
  clasificaciones: string[];
  cuenta: { codigo: string; nombre: string } | null;
  motivo: string | null;
  actualizado_en: string | null;
  opciones: Array<{ codigo: string; nombre: string; requiere_tercero: boolean }>;
}

export interface Regla {
  id: string;
  nombre: string;
  rut_contraparte: string | null;
  texto: string | null;
  sentido: 'ABONO' | 'CARGO' | 'AMBOS';
  cuenta_contable: string;
  concepto: string | null;
  tercero: string | null;
  glosa: string;
}

export interface Tercero {
  id: string;
  rut: string;
  razon_social: string;
}
