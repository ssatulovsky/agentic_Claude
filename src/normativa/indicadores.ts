import type pg from 'pg';

/**
 * Sincronización de UF y UTM desde fuentes oficiales o que las reproducen.
 *
 * Reglas:
 *   * Con más de una fuente, un valor solo se guarda si todas las fuentes que lo
 *     publican coinciden al centavo. Una diferencia se informa y NO se guarda.
 *   * Un valor ya guardado nunca se sobrescribe: si una fuente publica otro valor
 *     para la misma fecha, se informa como conflicto para revisión humana.
 *   * Se rechazan variaciones inverosímiles (UF > 1% diario, UTM > 3% mensual).
 *   * La UTA del mes se calcula como 12 veces la UTM del mes.
 */

export type TipoSincronizable = 'UF' | 'UTM';

export interface ValorIndicador {
  tipo: TipoSincronizable;
  /** Fecha en Chile (AAAA-MM-DD); UTM con el primer día del mes. */
  fecha: string;
  /** Valor exacto con 2 decimales, como texto. */
  valor: string;
}

export interface FuenteIndicadores {
  nombre: string;
  url(tipo: TipoSincronizable, anio: number): string;
  obtener(tipo: TipoSincronizable, anio: number): Promise<ValorIndicador[]>;
}

export type Descargador = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const descargadorPorDefecto: Descargador = (url) => fetch(url, { signal: AbortSignal.timeout(20_000) });

const fechaChile = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Convierte un instante ISO (p. ej. medianoche de Chile expresada en UTC) a fecha de Chile. */
export function aFechaChile(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) throw new Error(`Fecha inválida: ${iso}`);
  return fechaChile.format(fecha);
}

/** Número a texto con 2 decimales. Un valor con más decimales es un error de la fuente: no se redondea. */
function aTextoDosDecimales(valor: number): string {
  if (!Number.isFinite(valor) || valor <= 0) throw new Error(`Valor inválido: ${valor}`);
  const centavos = Math.round(valor * 100);
  if (Math.abs(valor * 100 - centavos) > 1e-6) throw new Error(`Valor con más de 2 decimales: ${valor}`);
  return (centavos / 100).toFixed(2);
}

/** Una fuente no puede publicar dos valores para la misma fecha (p. ej., por un error de zona horaria). */
function sinDuplicados(valores: ValorIndicador[]): ValorIndicador[] {
  const vistas = new Set<string>();
  for (const v of valores) {
    if (vistas.has(v.fecha)) throw new Error(`La fuente publica dos valores para ${v.fecha}`);
    vistas.add(v.fecha);
  }
  return valores;
}

async function descargarJson(descargar: Descargador, url: string): Promise<unknown> {
  const respuesta = await descargar(url);
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
  return respuesta.json();
}

/** mindicador.cl: reproduce los valores publicados por el Banco Central de Chile. */
export class FuenteMindicador implements FuenteIndicadores {
  readonly nombre = 'mindicador.cl (valores del Banco Central de Chile)';
  constructor(private readonly descargar: Descargador = descargadorPorDefecto) {}

  url(tipo: TipoSincronizable, anio: number): string {
    return `https://mindicador.cl/api/${tipo.toLowerCase()}/${anio}`;
  }

  async obtener(tipo: TipoSincronizable, anio: number): Promise<ValorIndicador[]> {
    const datos = (await descargarJson(this.descargar, this.url(tipo, anio))) as { serie?: { fecha: string; valor: number }[] };
    if (!Array.isArray(datos.serie)) throw new Error('Respuesta sin "serie"');
    return sinDuplicados(
      datos.serie.map((s) => {
        const fecha = aFechaChile(s.fecha);
        return { tipo, fecha: tipo === 'UTM' ? `${fecha.slice(0, 7)}-01` : fecha, valor: aTextoDosDecimales(s.valor) };
      }),
    );
  }
}

/**
 * API de la Comisión para el Mercado Financiero (requiere clave gratuita).
 * Formato esperado: {"UFs":[{"Valor":"41.247,63","Fecha":"2026-10-31"}]} y {"UTMs":[...]}.
 * Pendiente: confirmar el formato con una clave real antes de usarla en producción.
 */
export class FuenteCmf implements FuenteIndicadores {
  readonly nombre = 'CMF Chile (api.cmfchile.cl)';
  constructor(
    private readonly apiKey: string,
    private readonly descargar: Descargador = descargadorPorDefecto,
  ) {}

  url(tipo: TipoSincronizable, anio: number): string {
    return `https://api.cmfchile.cl/api-sbifv3/recursos_api/${tipo.toLowerCase()}/${anio}?apikey=${encodeURIComponent(this.apiKey)}&formato=json`;
  }

  async obtener(tipo: TipoSincronizable, anio: number): Promise<ValorIndicador[]> {
    const datos = (await descargarJson(this.descargar, this.url(tipo, anio))) as Record<string, { Valor: string; Fecha: string }[]>;
    const lista = datos[tipo === 'UF' ? 'UFs' : 'UTMs'];
    if (!Array.isArray(lista)) throw new Error(`Respuesta sin "${tipo === 'UF' ? 'UFs' : 'UTMs'}"`);
    return sinDuplicados(
      lista.map((x) => {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(x.Fecha)) throw new Error(`Fecha inválida: ${x.Fecha}`);
        const numero = Number(x.Valor.replace(/\./gu, '').replace(',', '.'));
        return { tipo, fecha: tipo === 'UTM' ? `${x.Fecha.slice(0, 7)}-01` : x.Fecha, valor: aTextoDosDecimales(numero) };
      }),
    );
  }
}

export interface ResumenSincronizacion {
  insertados: number;
  yaExistentes: number;
  /** Fuentes que publican valores distintos para la misma fecha (no se guardó nada para esa fecha). */
  discrepancias: { tipo: string; fecha: string; valores: Record<string, string> }[];
  /** Fechas ya guardadas para las que una fuente publica otro valor (no se sobrescribió). */
  conflictos: { tipo: string; fecha: string; guardado: string; publicado: string }[];
  /** Valores que no se guardaron por falta de confirmación (falta una fuente o no hay valor de referencia). */
  sinConfirmar: { tipo: string; fecha: string; motivo: string }[];
  /** Variaciones inverosímiles rechazadas. */
  rechazados: { tipo: string; fecha: string; valor: string; motivo: string }[];
  erroresFuente: { fuente: string; tipo: string; anio: number; error: string }[];
}

/** Variación máxima aceptada por unidad de distancia: UF por día, UTM por mes. */
const VARIACION_MAXIMA: Record<TipoSincronizable, number> = { UF: 0.01, UTM: 0.03 };
/** Distancia máxima para que un valor guardado sirva de referencia: 45 días (UF) o 3 meses (UTM). */
const DISTANCIA_REFERENCIA: Record<TipoSincronizable, number> = { UF: 45, UTM: 3 };

function distancia(tipo: TipoSincronizable, a: string, b: string): number {
  if (tipo === 'UTM') {
    const meses = (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + (Number(a.slice(5, 7)) - Number(b.slice(5, 7)));
    return Math.max(1, Math.abs(meses));
  }
  return Math.max(1, Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/**
 * Descarga, concilia y guarda, todo en una transacción con candado (dos ejecuciones
 * simultáneas no se pisan). Usa una conexión de plataforma (rol erp_owner),
 * porque la aplicación no puede escribir indicadores.
 */
export async function sincronizarIndicadores(
  cliente: pg.ClientBase,
  fuentes: FuenteIndicadores[],
  anios: number[],
  tipos: TipoSincronizable[] = ['UF', 'UTM'],
): Promise<ResumenSincronizacion> {
  if (fuentes.length === 0) throw new Error('Se necesita al menos una fuente');
  const resumen: ResumenSincronizacion = {
    insertados: 0, yaExistentes: 0, discrepancias: [], conflictos: [], sinConfirmar: [], rechazados: [], erroresFuente: [],
  };

  // Descarga fuera de la transacción (puede tardar).
  const descargas: { tipo: TipoSincronizable; anio: number; porFecha: Map<string, Map<string, string>>; urls: Map<string, string> }[] = [];
  for (const tipo of tipos) {
    for (const anio of anios) {
      const porFecha = new Map<string, Map<string, string>>();
      const urls = new Map<string, string>();
      for (const fuente of fuentes) {
        try {
          for (const v of await fuente.obtener(tipo, anio)) {
            if (!porFecha.has(v.fecha)) porFecha.set(v.fecha, new Map());
            porFecha.get(v.fecha)!.set(fuente.nombre, v.valor);
          }
          urls.set(fuente.nombre, fuente.url(tipo, anio).replace(/apikey=[^&]+/u, 'apikey=***'));
        } catch (error) {
          resumen.erroresFuente.push({ fuente: fuente.nombre, tipo, anio, error: (error as Error).message });
        }
      }
      descargas.push({ tipo, anio, porFecha, urls });
    }
  }

  await cliente.query('BEGIN');
  try {
    await cliente.query(`SELECT pg_advisory_xact_lock(hashtext('sincronizacion_indicadores'))`);
    for (const { tipo, porFecha, urls } of descargas) {
      for (const fecha of [...porFecha.keys()].sort()) {
        const valores = porFecha.get(fecha)!;
        if (new Set(valores.values()).size > 1) {
          resumen.discrepancias.push({ tipo, fecha, valores: Object.fromEntries(valores) });
          continue;
        }
        // Con varias fuentes configuradas, todas deben haber confirmado el valor.
        if (valores.size < fuentes.length) {
          resumen.sinConfirmar.push({ tipo, fecha, motivo: `solo lo publicó ${[...valores.keys()].join(', ')}` });
          continue;
        }
        const valor = [...valores.values()][0]!;
        const nombres = [...valores.keys()];

        const { rows: existente } = await cliente.query<{ valor: string }>(
          `SELECT valor::text FROM indicadores_economicos WHERE tipo = $1 AND fecha = $2`,
          [tipo, fecha],
        );
        if (existente[0]) {
          if (existente[0].valor === valor) resumen.yaExistentes++;
          else resumen.conflictos.push({ tipo, fecha, guardado: existente[0].valor, publicado: valor });
        } else {
          // Verosimilitud contra los valores guardados más cercanos a ambos lados.
          const { rows: vecinos } = await cliente.query<{ fecha: string; valor: string }>(
            `(SELECT fecha::text, valor::text FROM indicadores_economicos WHERE tipo = $1 AND fecha < $2 ORDER BY fecha DESC LIMIT 1)
             UNION ALL
             (SELECT fecha::text, valor::text FROM indicadores_economicos WHERE tipo = $1 AND fecha > $2 ORDER BY fecha ASC LIMIT 1)`,
            [tipo, fecha],
          );
          // Solo sirven de referencia los valores cercanos (una referencia lejana admitiría casi cualquier valor).
          const cercanos = vecinos.filter((v) => distancia(tipo, fecha, v.fecha) <= DISTANCIA_REFERENCIA[tipo]);
          if (cercanos.length === 0 && fuentes.length < 2) {
            resumen.sinConfirmar.push({ tipo, fecha, motivo: 'sin valor de referencia: se requieren dos fuentes' });
            continue;
          }
          const fueraDeRango = cercanos.find(
            (v) => Math.abs(Number(valor) / Number(v.valor) - 1) > VARIACION_MAXIMA[tipo] * distancia(tipo, fecha, v.fecha),
          );
          if (fueraDeRango) {
            const variacion = Math.abs(Number(valor) / Number(fueraDeRango.valor) - 1);
            resumen.rechazados.push({
              tipo, fecha, valor,
              motivo: `variación de ${(variacion * 100).toFixed(2)}% respecto del valor del ${fueraDeRango.fecha}`,
            });
            continue;
          }
          await cliente.query(
            `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente) VALUES ($1, $2, $3, $4, $5)`,
            [tipo, fecha, valor, nombres.join(' + '), urls.get(nombres[0]!)!],
          );
          resumen.insertados++;
        }

        // UTA del mes = 12 × UTM, también para UTM ya existentes; una diferencia se informa.
        if (tipo === 'UTM') {
          const { rows: utm } = await cliente.query<{ valor: string }>(
            `SELECT valor::text FROM indicadores_economicos WHERE tipo = 'UTM' AND fecha = $1`,
            [fecha],
          );
          if (utm[0]) {
            const uta = (Number(utm[0].valor) * 12).toFixed(2);
            const { rows: utaGuardada } = await cliente.query<{ valor: string }>(
              `SELECT valor::text FROM indicadores_economicos WHERE tipo = 'UTA' AND fecha = $1`,
              [fecha],
            );
            if (!utaGuardada[0]) {
              await cliente.query(
                `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente) VALUES ('UTA', $1, $2, $3, $4)`,
                [fecha, uta, 'Calculada: 12 × UTM del mes', urls.get(nombres[0]!)!],
              );
              resumen.insertados++;
            } else if (utaGuardada[0].valor !== uta) {
              resumen.conflictos.push({ tipo: 'UTA', fecha, guardado: utaGuardada[0].valor, publicado: uta });
            }
          }
        }
      }
    }

    await cliente.query(
      `SELECT bitacora_registrar('SISTEMA', 'sincronizacion-indicadores', 'indicadores.sincronizados', 'indicadores_economicos', NULL, $1::jsonb)`,
      [
        JSON.stringify({
          insertados: resumen.insertados,
          ya_existentes: resumen.yaExistentes,
          discrepancias: resumen.discrepancias,
          conflictos: resumen.conflictos,
          sin_confirmar: resumen.sinConfirmar.length,
          rechazados: resumen.rechazados,
          errores_fuente: resumen.erroresFuente,
          fuentes: fuentes.map((f) => f.nombre),
        }),
      ],
    );
    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  }
  return resumen;
}
