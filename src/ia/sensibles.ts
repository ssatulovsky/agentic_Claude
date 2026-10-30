/**
 * Filtro de datos sensibles. Regla de la gerencia: ninguna contraseña, clave tributaria,
 * certificado ni clave de API se envía a un modelo de IA en la nube. Antes de cada envío
 * se reemplazan por [DATO PROTEGIDO]. Los modelos locales (en el propio servidor) no se
 * filtran, porque los datos no salen.
 */

const MARCA = '[DATO PROTEGIDO]';

const PATRONES: Array<[RegExp, string]> = [
  // Certificados y claves privadas (PEM).
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/gu, MARCA],
  // Claves de API conocidas y tokens.
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/gu, MARCA],
  [/\bsk-[A-Za-z0-9]{20,}/gu, MARCA],
  [/\bAIza[0-9A-Za-z_-]{30,}/gu, MARCA],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, MARCA],
  // Hashes de contraseñas y secretos de doble factor.
  [/\$argon2[a-z]*\$[^\s"']+/gu, MARCA],
  [/otpauth:\/\/[^\s"']+/gu, MARCA],
  // "contraseña: xxx", "clave SII = xxx", "password xxx", "clave tributaria es xxx"…
  [
    /\b(contrase(?:ñ|n)a|clave\s+(?:tributaria|del?\s+sii|sii|secreta|de\s+acceso|del\s+certificado|bancaria)|password|passwd|pwd|api[_ -]?key|secreto)\b(\s*(?:es|:|=)\s*|\s+)(["']?)(?!\[DATO)([^\s"',;]{4,})\3/giu,
    `$1$2${MARCA}`,
  ],
  // "la clave es xxx", "pin: 1234", "token = xxx" (solo con ":" "=" o "es": "clave 1.1.02" es una cuenta).
  [/\b(clave|pin|token)\b(\s*[:=]\s*|\s+es\s+)(["']?)(?!\[DATO)([^\s"',;]{4,})\3/giu, `$1$2${MARCA}`],
];

/** Nombres de campo que siempre contienen secretos (no "clave" a secas: los parámetros legales la usan). */
const CLAVES_SECRETAS = /^(contrase|password|passwd|secret|totp|api_?key|token|certificado|clave_(sii|tributaria|certificado|secreta|acceso)|.*_hash$)/iu;

export interface ResultadoFiltro<T> {
  valor: T;
  reemplazos: number;
}

export function filtrarTexto(texto: string): ResultadoFiltro<string> {
  let reemplazos = 0;
  let r = texto;
  for (const [patron, reemplazo] of PATRONES) {
    r = r.replace(patron, (...args) => {
      reemplazos++;
      const grupos = args.slice(1, -2) as Array<string | undefined>;
      return reemplazo.replace(/\$(\d)/gu, (_m, n: string) => grupos[Number(n) - 1] ?? '');
    });
  }
  return { valor: r, reemplazos };
}

/** Filtra todos los textos de un valor JSON (resultados de herramientas, mensajes). */
export function filtrarValor<T>(valor: T): ResultadoFiltro<T> {
  let reemplazos = 0;
  const recorrer = (v: unknown, clave?: string): unknown => {
    if (typeof v === 'string') {
      // Campos que por su nombre son secretos se ocultan completos.
      if (clave && CLAVES_SECRETAS.test(clave) && v.length > 0) {
        reemplazos++;
        return MARCA;
      }
      const f = filtrarTexto(v);
      reemplazos += f.reemplazos;
      return f.valor;
    }
    if (Array.isArray(v)) return v.map((x) => recorrer(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, recorrer(x, k)]));
    }
    return v;
  };
  return { valor: recorrer(valor) as T, reemplazos };
}
