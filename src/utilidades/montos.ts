/**
 * Montos en centavos con enteros (BigInt). Nunca se usan números de coma
 * flotante para sumar dinero.
 */

/** Convierte "1234.5", "1234.50", 1234.5 o "-10" a centavos. Rechaza más de 2 decimales. */
export function aCentavos(valor: string | number): bigint {
  const texto = typeof valor === 'number' ? valor.toFixed(2) : valor.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/u.exec(texto);
  if (!m) {
    throw new Error(`Monto inválido: ${valor}`);
  }
  const [, signo, entero, decimales = ''] = m;
  const centavos = BigInt(entero!) * 100n + BigInt((decimales + '00').slice(0, 2));
  return signo ? -centavos : centavos;
}

/** Centavos a texto decimal con 2 decimales ("1234.50"). */
export function deCentavos(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = abs / 100n;
  const decimales = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${entero}.${decimales}`;
}

/** Formato chileno para mostrar a personas: $1.234.567 (o con decimales si los hay). */
export function formatoPesos(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  const decimales = abs % 100n;
  return `${negativo ? '-' : ''}$${entero}${decimales === 0n ? '' : `,${decimales.toString().padStart(2, '0')}`}`;
}

export const maxCentavos = (a: bigint, b: bigint) => (a > b ? a : b);
