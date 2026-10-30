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

/** Número a texto con 2 decimales, sin errores de coma flotante en el redondeo. */
function aTextoDosDecimales(valor: number): string {
  if (!Number.isFinite(valor) || valor <= 0) throw new Error(`Valor inválido: ${valor}`);
  return (Math.round(valor * 100) / 100).toFixed(2);
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
    return datos.serie.map((s) => {
      const fecha = aFechaChile(s.fecha);
      return { tipo, fecha: tipo === 'UTM' ? `${fecha.slice(0, 7)}-01` : fecha, valor: aTextoDosDecimales(s.valor) };
    });
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
    return lista.map((x) => {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(x.Fecha)) throw new Error(`Fecha inválida: ${x.Fecha}`);
      const numero = Number(x.Valor.replace(/\./gu, '').replace(',', '.'));
      return { tipo, fecha: tipo === 'UTM' ? `${x.Fecha.slice(0, 7)}-01` : x.Fecha, valor: aTextoDosDecimales(numero) };
    });
  }
}

export interface ResumenSincronizacion {
  insertados: number;
  yaExistentes: number;
  /** Fuentes que publican valores distintos para la misma fecha (no se guardó nada para esa fecha). */
  discrepancias: { tipo: string; fecha: string; valores: Record<string, string> }[];
  /** Fechas ya guardadas para las que una fuente publica otro valor (no se sobrescribió). */
  conflictos: { tipo: string; fecha: string; guardado: string; publicado: string }[];
  /** Variaciones inverosímiles rechazadas. */
  rechazados: { tipo: string; fecha: string; valor: string; motivo: string }[];
  erroresFuente: { fuente: string; tipo: string; anio: number; error: string }[];
}

const VARIACION_MAXIMA: Record<TipoSincronizable, number> = { UF: 0.01, UTM: 0.03 };

/**
 * Descarga, concilia y guarda. Usa una conexión de plataforma (rol erp_owner),
 * porque la aplicación no puede escribir indicadores.
 */
export async function sincronizarIndicadores(
  cliente: pg.ClientBase,
  fuentes: FuenteIndicadores[],
  anios: number[],
  tipos: TipoSincronizable[] = ['UF', 'UTM'],
): Promise<ResumenSincronizacion> {
  if (fuentes.length === 0) throw new Error('Se necesita al menos una fuente');
  const resumen: ResumenSincronizacion = { insertados: 0, yaExistentes: 0, discrepancias: [], conflictos: [], rechazados: [], erroresFuente: [] };

  for (const tipo of tipos) {
    for (const anio of anios) {
      // fecha -> fuente -> valor
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

      const fechas = [...porFecha.keys()].sort();
      for (const fecha of fechas) {
        const valores = porFecha.get(fecha)!;
        const distintos = new Set(valores.values());
        if (distintos.size > 1) {
          resumen.discrepancias.push({ tipo, fecha, valores: Object.fromEntries(valores) });
          continue;
        }
        const valor = [...distintos][0]!;
        const nombres = [...valores.keys()];

        // Verosimilitud contra el valor anterior guardado.
        const { rows: anterior } = await cliente.query<{ valor: string }>(
          `SELECT valor::text FROM indicadores_economicos WHERE tipo = $1 AND fecha < $2 ORDER BY fecha DESC LIMIT 1`,
          [tipo, fecha],
        );
        if (anterior[0]) {
          const variacion = Math.abs(Number(valor) / Number(anterior[0].valor) - 1);
          if (variacion > VARIACION_MAXIMA[tipo]) {
            resumen.rechazados.push({ tipo, fecha, valor, motivo: `variación de ${(variacion * 100).toFixed(2)}% respecto del valor anterior` });
            continue;
          }
        }

        const { rows: existente } = await cliente.query<{ valor: string }>(
          `SELECT valor::text FROM indicadores_economicos WHERE tipo = $1 AND fecha = $2`,
          [tipo, fecha],
        );
        if (existente[0]) {
          if (existente[0].valor === valor) resumen.yaExistentes++;
          else resumen.conflictos.push({ tipo, fecha, guardado: existente[0].valor, publicado: valor });
          continue;
        }
        await cliente.query(
          `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente) VALUES ($1, $2, $3, $4, $5)`,
          [tipo, fecha, valor, nombres.join(' + '), urls.get(nombres[0]!) ?? fuentes[0]!.url(tipo, anio)],
        );
        resumen.insertados++;

        if (tipo === 'UTM') {
          const uta = (Number(valor) * 12).toFixed(2);
          const r = await cliente.query(
            `INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente)
             VALUES ('UTA', $1, $2, $3, $4) ON CONFLICT (tipo, fecha) DO NOTHING`,
            [fecha, uta, 'Calculada: 12 × UTM del mes', urls.get(nombres[0]!) ?? fuentes[0]!.url(tipo, anio)],
          );
          resumen.insertados += r.rowCount ?? 0;
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
        rechazados: resumen.rechazados,
        errores_fuente: resumen.erroresFuente,
        fuentes: fuentes.map((f) => f.nombre),
      }),
    ],
  );
  return resumen;
}
