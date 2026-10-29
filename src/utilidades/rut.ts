/** Normaliza un RUT chileno a la forma 12345678-K (sin puntos, DV en mayúscula). */
export function normalizarRut(rut: string): string {
  const limpio = rut.replace(/[.\s]/gu, '').toUpperCase();
  if (limpio.includes('-')) return limpio;
  return limpio.length > 1 ? `${limpio.slice(0, -1)}-${limpio.slice(-1)}` : limpio;
}

/** Valida el dígito verificador (módulo 11). */
export function rutEsValido(rut: string): boolean {
  const normalizado = normalizarRut(rut);
  const m = /^(\d{1,8})-([\dK])$/u.exec(normalizado);
  if (!m) return false;
  const [, cuerpo, dv] = m as unknown as [string, string, string];
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return esperado === dv;
}
