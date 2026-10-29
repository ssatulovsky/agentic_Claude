import { sql } from 'kysely';
import { z } from 'zod';
import type { Trx } from '../db/conexion.js';
import { ErrorNegocio } from '../errores.js';

/**
 * Motor de normativa. Toda regla legal se consulta por clave y fecha.
 * Si no existe un valor aprobado vigente, se lanza un error: el sistema nunca
 * inventa ni supone un valor legal.
 */

export interface ParametroLegal {
  clave: string;
  /** Valor exacto como texto decimal (sin pérdida de precisión). */
  valor: string;
  unidad: 'PORCENTAJE' | 'UF' | 'UTM' | 'CLP' | 'FACTOR';
  vigenteDesde: string;
  vigenteHasta: string | null;
  fuente: string;
  urlFuente: string;
  nota: string | null;
}

export class ParametroNoVigente extends ErrorNegocio {
  constructor(clave: string, fecha: string) {
    super(
      'PARAMETRO_NO_VIGENTE',
      `No hay un valor aprobado de ${clave} vigente al ${fecha}. Debe cargarse y aprobarse antes de calcular.`,
      422,
      { clave, fecha },
    );
  }
}

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD');

export async function obtenerParametro(trx: Trx, clave: string, fecha: string): Promise<ParametroLegal> {
  fechaIso.parse(fecha);
  const fila = await trx
    .selectFrom('parametros_legales')
    .select(['clave', 'valor', 'unidad', 'vigente_desde', 'vigente_hasta', 'fuente', 'url_fuente', 'nota'])
    .where('clave', '=', clave)
    .where('estado', '=', 'APROBADO')
    .where(sql<boolean>`daterange(vigente_desde, vigente_hasta, '[)') @> ${fecha}::date`)
    .executeTakeFirst();
  if (!fila) {
    throw new ParametroNoVigente(clave, fecha);
  }
  return {
    clave: fila.clave,
    valor: fila.valor,
    unidad: fila.unidad,
    vigenteDesde: fila.vigente_desde,
    vigenteHasta: fila.vigente_hasta,
    fuente: fila.fuente,
    urlFuente: fila.url_fuente,
    nota: fila.nota,
  };
}

export async function obtenerTablaLegal<T>(
  trx: Trx,
  clave: string,
  fecha: string,
  esquema: z.ZodType<T>,
): Promise<{ contenido: T; fuente: string; urlFuente: string; vigenteDesde: string }> {
  fechaIso.parse(fecha);
  const fila = await trx
    .selectFrom('tablas_legales')
    .select(['contenido', 'fuente', 'url_fuente', 'vigente_desde'])
    .where('clave', '=', clave)
    .where('estado', '=', 'APROBADO')
    .where(sql<boolean>`daterange(vigente_desde, vigente_hasta, '[)') @> ${fecha}::date`)
    .executeTakeFirst();
  if (!fila) {
    throw new ParametroNoVigente(clave, fecha);
  }
  return {
    contenido: esquema.parse(fila.contenido),
    fuente: fila.fuente,
    urlFuente: fila.url_fuente,
    vigenteDesde: fila.vigente_desde,
  };
}

export type TipoIndicador = 'UF' | 'UTM' | 'UTA';

/**
 * Valor de un indicador. La UF es diaria; UTM y UTA se registran con el primer
 * día del mes y se consultan por el mes de la fecha indicada.
 */
export async function obtenerIndicador(
  trx: Trx,
  tipo: TipoIndicador,
  fecha: string,
): Promise<{ valor: string; fecha: string; fuente: string }> {
  fechaIso.parse(fecha);
  const fechaBusqueda = tipo === 'UF' ? fecha : `${fecha.slice(0, 7)}-01`;
  const fila = await trx
    .selectFrom('indicadores_economicos')
    .select(['valor', 'fecha', 'fuente'])
    .where('tipo', '=', tipo)
    .where('fecha', '=', fechaBusqueda)
    .executeTakeFirst();
  if (!fila) {
    throw new ErrorNegocio('INDICADOR_NO_DISPONIBLE', `No hay valor de ${tipo} para ${fechaBusqueda}.`, 422, {
      tipo,
      fecha: fechaBusqueda,
    });
  }
  return { valor: fila.valor, fecha: fila.fecha, fuente: fila.fuente };
}

// ---------------------------------------------------------------------------
// Ejemplo de regla construida sobre el motor: impuesto único de segunda categoría.
// El cálculo se hace en centésimos de peso con enteros (sin errores de coma flotante).
// ---------------------------------------------------------------------------

export const esquemaTablaImpuestoUnico = z.object({
  unidad: z.literal('UTM'),
  tramos: z
    .array(
      z.object({
        desde: z.number().nonnegative(),
        hasta: z.number().positive().nullable(),
        factor: z.number().min(0).max(1),
        rebaja: z.number().nonnegative(),
      }),
    )
    .min(1)
    // Tramos contiguos desde 0 y el último sin tope: así toda renta cae en un tramo.
    .refine((t) => t[0]!.desde === 0, 'El primer tramo debe partir en 0')
    .refine((t) => t.at(-1)!.hasta === null, 'El último tramo debe ser abierto (hasta = null)')
    .refine(
      (t) => t.every((tramo, i) => i === t.length - 1 || (tramo.hasta !== null && t[i + 1]!.desde === tramo.hasta)),
      'Los tramos deben ser contiguos, sin huecos ni superposiciones',
    ),
});

export interface ResultadoImpuestoUnico {
  impuestoPesos: number;
  tramo: number;
  factor: number;
  rebajaPesos: number;
  utm: string;
  fuente: string;
}

/** Convierte un decimal en texto a un entero escalado (p. ej. "72151.00" con escala 100 → 7215100). */
export function aEnteroEscalado(decimal: string, escala: number): bigint {
  const [entero = '0', fraccion = ''] = decimal.split('.');
  const digitos = Math.round(Math.log10(escala));
  const fraccionAjustada = (fraccion + '0'.repeat(digitos)).slice(0, digitos);
  const signo = entero.startsWith('-') ? -1n : 1n;
  return signo * (BigInt(entero.replace('-', '')) * BigInt(escala) + BigInt(fraccionAjustada || '0'));
}

export async function calcularImpuestoUnicoMensual(
  trx: Trx,
  rentaLiquidaImponiblePesos: number,
  fecha: string,
): Promise<ResultadoImpuestoUnico> {
  if (!Number.isInteger(rentaLiquidaImponiblePesos) || rentaLiquidaImponiblePesos < 0) {
    throw new ErrorNegocio('DATO_INVALIDO', 'La renta líquida imponible debe ser un entero de pesos no negativo.', 422);
  }
  const [tabla, utm] = await Promise.all([
    obtenerTablaLegal(trx, 'IMPUESTO_UNICO.MENSUAL', fecha, esquemaTablaImpuestoUnico),
    obtenerIndicador(trx, 'UTM', fecha),
  ]);
  const utmCentavos = aEnteroEscalado(utm.valor, 100);
  const rentaCentavos = BigInt(rentaLiquidaImponiblePesos) * 100n;
  // Factores y límites de la tabla se escalan a diezmilésimos para operar con enteros.
  const indice = tabla.contenido.tramos.findIndex((t) => {
    const desde = (aEnteroEscalado(String(t.desde), 10000) * utmCentavos) / 10000n;
    const hasta = t.hasta === null ? null : (aEnteroEscalado(String(t.hasta), 10000) * utmCentavos) / 10000n;
    return rentaCentavos > desde && (hasta === null || rentaCentavos <= hasta);
  });
  if (indice === -1 && rentaCentavos > 0n) {
    throw new ErrorNegocio('TABLA_INCONSISTENTE', 'La renta no cae en ningún tramo de la tabla vigente.', 500);
  }
  const posicion = indice === -1 ? 0 : indice;
  const tramo = tabla.contenido.tramos[posicion]!;
  const factor = aEnteroEscalado(String(tramo.factor), 10000);
  const rebajaCentavos = (aEnteroEscalado(String(tramo.rebaja), 10000) * utmCentavos) / 10000n;
  const impuestoCentavos = (rentaCentavos * factor) / 10000n - rebajaCentavos;
  const positivo = impuestoCentavos > 0n ? impuestoCentavos : 0n;
  // Redondeo al peso más cercano.
  const impuestoPesos = Number((positivo + 50n) / 100n);
  return {
    impuestoPesos,
    tramo: posicion + 1,
    factor: tramo.factor,
    rebajaPesos: Number((rebajaCentavos + 50n) / 100n),
    utm: utm.valor,
    fuente: tabla.fuente,
  };
}
