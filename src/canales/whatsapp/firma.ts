import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de los mensajes entre el ERP y el puente de WhatsApp (en ambos sentidos):
 *   X-ERP-Marca-Tiempo: segundos Unix
 *   X-ERP-Firma: sha256=<hex de HMAC-SHA256(secreto, "<marca>.<cuerpo>")>
 * Se rechaza una marca de tiempo con más de 5 minutos de diferencia (repetición).
 */
export const CABECERA_FIRMA = 'x-erp-firma';
export const CABECERA_MARCA = 'x-erp-marca-tiempo';
const TOLERANCIA_SEGUNDOS = 300;

export function firmar(secreto: string, marcaTiempo: number, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(`${marcaTiempo}.${cuerpo}`).digest('hex')}`;
}

export function cabecerasFirmadas(secreto: string, cuerpo: string, ahora = Date.now()): Record<string, string> {
  const marca = Math.floor(ahora / 1000);
  return { [CABECERA_MARCA]: String(marca), [CABECERA_FIRMA]: firmar(secreto, marca, cuerpo) };
}

export function firmaValida(secreto: string, marca: string | undefined, firma: string | undefined, cuerpo: string, ahora = Date.now()): boolean {
  if (!marca || !firma || !/^\d{9,11}$/u.test(marca)) return false;
  if (Math.abs(Math.floor(ahora / 1000) - Number(marca)) > TOLERANCIA_SEGUNDOS) return false;
  const esperada = Buffer.from(firmar(secreto, Number(marca), cuerpo));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
