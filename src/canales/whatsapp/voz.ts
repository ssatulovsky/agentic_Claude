/**
 * Texto que se dice en la nota de voz de una respuesta. El texto completo va siempre por
 * escrito; la voz es un resumen hablable: sin formato, con montos y RUT que el sintetizador
 * lee bien, y acotado.
 */
export type PreferenciaVoz = 'NUNCA' | 'SI_ENVIA_VOZ' | 'SIEMPRE';

export const LARGO_MAXIMO_VOZ = 700;

export function responderConVoz(preferencia: PreferenciaVoz, preguntoConVoz: boolean): boolean {
  return preferencia === 'SIEMPRE' || (preferencia === 'SI_ENVIA_VOZ' && preguntoConVoz);
}

/** "2.991.000" → "2991000" (los puntos de miles se leerían como "punto"). */
const sinMiles = (n: string) => n.replace(/\./gu, '');
/** Decimales con cero inicial se dicen dígito a dígito ("05" → "cero 5"). */
const decimales = (d: string) => (d.startsWith('0') ? d.split('').map((x) => (x === '0' ? 'cero' : x)).join(' ') : d);
/** Un número con miles "1.234.567" o simple "1234", que no siga con más dígitos. */
const NUMERO = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?![\d]|[.,]\d)`;

export function textoParaVoz(texto: string, largo = LARGO_MAXIMO_VOZ): string {
  // Se trabaja sobre un trozo acotado: el resto no se va a decir.
  let t = texto.slice(0, largo * 4)
    // Enlaces y código no se leen.
    .replace(/https?:\/\/\S+/gu, 'el enlace')
    .replace(/`[^`\n]*`/gu, '')
    // RUT: por partes, no como un número de millones.
    .replace(/\b(\d{1,2})\.(\d{3})\.(\d{3})-([\dkK])\b/gu, (_m, a: string, b: string, c: string, dv: string) => `RUT ${a} ${b} ${c} guion ${dv.toUpperCase() === 'K' ? 'K' : dv}`)
    .replace(/\bRUT RUT\b/gu, 'RUT')
    // Montos en dólares y pesos (con signo negativo antes o después del $).
    .replace(new RegExp(String.raw`(-\s?)?US\$\s?(-\s?)?${NUMERO}`, 'gu'), (_m, n1?: string, n2?: string, e?: string, d?: string) =>
      `${n1 || n2 ? 'menos ' : ''}${sinMiles(e!)}${d ? ` coma ${decimales(d)}` : ''} dólares`)
    .replace(new RegExp(String.raw`(-\s?)?\$\s?(-\s?)?${NUMERO}`, 'gu'), (_m, n1?: string, n2?: string, e?: string, d?: string) =>
      `${n1 || n2 ? 'menos ' : ''}${sinMiles(e!)}${d ? ` coma ${decimales(d)}` : ''} pesos`)
    // Otros números con miles y decimales.
    .replace(new RegExp(String.raw`(?<![\d.,])${NUMERO}`, 'gu'), (m, e: string, d?: string) =>
      e.includes('.') || d ? `${sinMiles(e)}${d ? ` coma ${decimales(d)}` : ''}` : m)
    // Formato de WhatsApp/markdown, viñetas y emojis.
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/gu, '$1$2')
    .replace(/[*~#>|]/gu, '')
    .replace(/^[^\S\n]*(?:[-•·]|\d+[.)])[^\S\n]+/gmu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[^\S\n]*\n\s*/gu, '. ')
    .replace(/\s{2,}/gu, ' ')
    .replace(/(\.\s*){2,}/gu, '. ')
    .trim();
  if (t.length > largo) {
    const corte = t.lastIndexOf('. ', largo);
    t = `${t.slice(0, corte > largo / 2 ? corte + 1 : largo).trim()} El detalle completo va por escrito.`;
  }
  return t;
}
