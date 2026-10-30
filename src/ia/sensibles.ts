/**
 * Filtro de datos sensibles. Regla de la gerencia: ninguna contraseña, clave tributaria,
 * certificado ni clave de API se envía a un modelo de IA en la nube. Antes de cada envío
 * se reemplazan por [DATO PROTEGIDO]. Los modelos locales (en el propio servidor) no se
 * filtran, porque los datos no salen.
 */

const MARCA = '[DATO PROTEGIDO]';

/** Valor de un secreto: entre comillas (con espacios) o una palabra. */
const VALOR = String.raw`(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|“[^”\n]{1,200}”|(?!\[DATO)[^\s"',;]+)`;
const PALABRA_SECRETA = String.raw`contrase(?:ñ|n)a|password|passwd|pwd|api[_ -]?key|secreto|credencial(?:es)?|clave|pin|token`;
/** Palabras que nunca son el valor (para "contraseña de la cuenta", "password es …"). */
const NO_VALOR = String.raw`(?![:=]|(?:es|era|ser[aá]|de|del|la|el|los|las|mi|mis|su|sus|tu|y|o|que|para|por|en|con|nueva|actual)\b)`;

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
  // "la clave de mi cuenta es X", "mi clave del certificado digital es 'a b c'", "pin: 12", "password = x".
  // ("clave 1.1.02" no se toca: sin "es", ":" ni "=" es un código de cuenta.)
  [new RegExp(String.raw`\b(${PALABRA_SECRETA})\b([^\n.:=]{0,40}?(?:\s(?:es|era|ser[aá])\s+|\s*[:=]\s*))${VALOR}`, 'giu'), `$1$2${MARCA}`],
  // "contraseña Xy12", "password abc" (palabra fuerte seguida directamente del valor).
  [
    new RegExp(String.raw`\b(contrase(?:ñ|n)a|password|passwd|pwd|api[_ -]?key|clave\s+(?:tributaria|sii|del\s+sii|secreta|de\s+acceso|bancaria|del\s+certificado))\b(\s+)${NO_VALOR}${VALOR}`, 'giu'),
    `$1$2${MARCA}`,
  ],
];

/**
 * Nombres de campo que contienen secretos, en cualquier parte del nombre (claveSii, mfaSecret,
 * password_hash…). No "clave" a secas: los parámetros legales y las cuentas la usan.
 */
const CLAVES_SECRETAS =
  /(contrase|password|passwd|secret|totp|mfa|otp|api_?key|apikey|token|certificado|credencial|clave_?(sii|tributaria|certificado|secreta|acceso|privada)|hash$)/iu;

/**
 * Palabras que delatan la intención de compartir una credencial. Un mensaje de una persona que
 * las contiene no se envía a ningún modelo (ni local): el filtro de reemplazo es una segunda
 * barrera, no la principal.
 */
const INTENCION_CREDENCIAL = new RegExp(
  String.raw`\b(contrase(?:ñ|n)a|password|passwd|credenciales?|api[_ -]?key|clave\s+(?:tributaria|sii|del\s+sii|secreta|de\s+acceso|bancaria|del?\s+(?:mi\s+)?(?:banco|cuenta|correo|certificado|internet))|clave\s+única|c[oó]digo\s+(?:de\s+)?(?:verificaci[oó]n|otp|2fa)|pin|token)\b`,
  'iu',
);

/** true si el texto de una persona parece incluir una contraseña, clave o certificado. */
export function contieneCredenciales(texto: string): boolean {
  return INTENCION_CREDENCIAL.test(texto) || filtrarTexto(texto).reemplazos > 0;
}

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
    // Un objeto o lista bajo un nombre secreto ("credenciales": {…}) se oculta completo.
    if (clave && CLAVES_SECRETAS.test(clave) && v !== null && typeof v === 'object') {
      reemplazos++;
      return MARCA;
    }
    if (Array.isArray(v)) return v.map((x) => recorrer(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, recorrer(x, k)]));
    }
    return v;
  };
  return { valor: recorrer(valor) as T, reemplazos };
}
