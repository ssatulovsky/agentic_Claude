import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de los mensajes entre el ERP y el puente de WhatsApp (en ambos sentidos):
 *   X-ERP-Marca-Tiempo: segundos Unix
 *   X-ERP-Firma: sha256=<hex de HMAC-SHA256(secreto, "<marca>.<MÉTODO> <ruta>.<cuerpo>")>
 * La ruta (p. ej. "POST /api/canales/whatsapp/mensajes" o "POST /enviar") fija el sentido:
 * una petición capturada en un sentido no sirve en el otro. Se rechaza una marca de tiempo
 * con más de 5 minutos de diferencia; las repeticiones dentro de ese plazo se descartan por
 * el identificador del mensaje.
 */
export const CABECERA_FIRMA = 'x-erp-firma';
export const CABECERA_MARCA = 'x-erp-marca-tiempo';
const TOLERANCIA_SEGUNDOS = 300;

export function firmar(secreto: string, marcaTiempo: number, destino: string, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(`${marcaTiempo}.${destino}.${cuerpo}`).digest('hex')}`;
}

/** Cabeceras firmadas para `destino` ("POST /ruta"). */
export function cabecerasFirmadas(secreto: string, destino: string, cuerpo: string, ahora = Date.now()): Record<string, string> {
  const marca = Math.floor(ahora / 1000);
  return { [CABECERA_MARCA]: String(marca), [CABECERA_FIRMA]: firmar(secreto, marca, destino, cuerpo) };
}

/** Revisión barata, antes de leer el cuerpo: cabeceras presentes y marca de tiempo vigente. */
export function marcaVigente(marca: string | undefined, firma: string | undefined, ahora = Date.now()): boolean {
  if (!marca || !firma || !/^\d{9,11}$/u.test(marca) || !/^sha256=[0-9a-f]{64}$/u.test(firma)) return false;
  return Math.abs(Math.floor(ahora / 1000) - Number(marca)) <= TOLERANCIA_SEGUNDOS;
}

export function firmaValida(secreto: string, marca: string | undefined, firma: string | undefined, destino: string, cuerpo: string, ahora = Date.now()): boolean {
  if (!marcaVigente(marca, firma, ahora)) return false;
  const esperada = Buffer.from(firmar(secreto, Number(marca), destino, cuerpo));
  const recibida = Buffer.from(firma!);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
