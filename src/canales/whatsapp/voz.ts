/**
 * Texto que se dice en la nota de voz de una respuesta. El texto completo va siempre por
 * escrito; la voz es un resumen hablable: sin formato, con los montos en palabras que el
 * sintetizador lee bien, y acotado.
 */
export type PreferenciaVoz = 'NUNCA' | 'SI_ENVIA_VOZ' | 'SIEMPRE';

export const LARGO_MAXIMO_VOZ = 700;

export function responderConVoz(preferencia: PreferenciaVoz, preguntoConVoz: boolean): boolean {
  return preferencia === 'SIEMPRE' || (preferencia === 'SI_ENVIA_VOZ' && preguntoConVoz);
}

/** "2.991.000" → "2991000" (sin puntos de miles, que se leerían como "punto"). */
const sinMiles = (n: string) => n.replace(/\./gu, '');

export function textoParaVoz(texto: string, largo = LARGO_MAXIMO_VOZ): string {
  let t = texto
    // Enlaces y código no se leen.
    .replace(/https?:\/\/\S+/gu, 'el enlace')
    .replace(/`[^`]*`/gu, '')
    // Montos: US$ y $ chilenos, con miles y decimales con coma.
    .replace(/US\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/gu, (_m, e: string, d?: string) => `${sinMiles(e)}${d ? ` coma ${d}` : ''} dólares`)
    .replace(/\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/gu, (_m, e: string, d?: string) => `${sinMiles(e)}${d ? ` coma ${d}` : ''} pesos`)
    .replace(/\b(\d{1,3}(?:\.\d{3})+)\b/gu, (_m, e: string) => sinMiles(e))
    .replace(/(\d),(\d)/gu, '$1 coma $2')
    // Formato de WhatsApp/markdown, viñetas y emojis.
    .replace(/[*_~#>|]/gu, '')
    .replace(/^\s*(?:[-•·]|\d+[.)])\s+/gmu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*\n+\s*/gu, '. ')
    .replace(/\s{2,}/gu, ' ')
    .replace(/(\.\s*){2,}/gu, '. ')
    .trim();
  if (t.length > largo) {
    const corte = t.lastIndexOf('. ', largo);
    t = `${t.slice(0, corte > largo / 2 ? corte + 1 : largo).trim()} El detalle completo va por escrito.`;
  }
  return t;
}
