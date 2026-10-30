import { z } from 'zod';
import { registrarAsiento } from '../../contabilidad/libroDiario.js';
import { balanceOchoColumnas, libroMayor } from '../../contabilidad/reportes.js';
import { aCentavos, deCentavos, formatoPesos } from '../../utilidades/montos.js';
import { sql } from 'kysely';
import type { DefinicionHerramienta, Hallazgo } from '../tipos.js';

/** Monto desde el cual el Contralor pide una revisión con motivo, si la empresa no fijó otro. */
export const UMBRAL_OBSERVACION_ASIENTO = 10_000_000;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe('Fecha AAAA-MM-DD');
// Números grandes como texto: un número JSON mayor que 2^53 pierde precisión en silencio.
const monto = z
  .union([z.number().nonnegative().max(999_999_999_999), z.string().regex(/^\d{1,16}(\.\d{1,2})?$/u)])
  .describe('Monto en pesos, con hasta 2 decimales; montos sobre un billón, como texto');

export const consultarBalance: DefinicionHerramienta<{ hasta: string }, unknown> = {
  nombre: 'consultar_balance',
  descripcion:
    'Balance de 8 columnas (comprobación y saldos) acumulado del ejercicio hasta una fecha: débitos, créditos, saldos, inventario, resultados y resultado del ejercicio.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.asientos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ hasta: fecha }),
  async ejecutar({ trx, seguridad }, e) {
    const b = await balanceOchoColumnas(trx, seguridad.empresaId, e.hasta);
    return { ...b, filas: b.filas.slice(0, 200), filasOmitidas: Math.max(b.filas.length - 200, 0) };
  },
};

export const consultarMayor: DefinicionHerramienta<{ cuenta: string; desde: string; hasta: string }, unknown> = {
  nombre: 'consultar_mayor',
  descripcion:
    'Libro mayor de una cuenta (o de una cuenta de agrupación con sus subcuentas) entre dos fechas del mismo ejercicio: saldo inicial, movimientos y saldo final.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.asientos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ cuenta: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u), desde: fecha, hasta: fecha }),
  async ejecutar({ trx, seguridad }, e) {
    const m = await libroMayor(trx, seguridad.empresaId, e.cuenta, e.desde, e.hasta);
    return { ...m, movimientos: m.movimientos.slice(0, 300), movimientosOmitidos: Math.max(m.movimientos.length - 300, 0) };
  },
};

const entradaAsiento = z
  .object({
    fecha,
    glosa: z.string().min(5).max(300),
    documentoReferencia: z.string().max(100).optional(),
    lineas: z
      .array(
        z.object({
          cuenta: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u),
          debe: monto.optional(),
          haber: monto.optional(),
          tercero: z.string().max(12).optional().describe('RUT del tercero'),
          centroCosto: z.string().max(20).optional(),
          glosa: z.string().max(200).optional(),
        }),
      )
      .min(2)
      .max(100),
  })
  .refine(
    (a) => {
      const d = a.lineas.reduce((s, l) => s + aCentavos(l.debe ?? 0), 0n);
      const h = a.lineas.reduce((s, l) => s + aCentavos(l.haber ?? 0), 0n);
      return d === h && d > 0n;
    },
    { message: 'El asiento debe cuadrar: suma del debe igual a la suma del haber, y mayor que cero' },
  );

export const proponerAsiento: DefinicionHerramienta<z.infer<typeof entradaAsiento>, unknown> = {
  nombre: 'proponer_asiento',
  descripcion:
    'Propone registrar un asiento contable. No lo registra: queda pendiente hasta que una persona autorizada lo apruebe. La base de datos vuelve a validar la partida doble, las cuentas y el período al aprobarse.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.asientos.registrar',
  autonomia: 'PROPONER',
  entrada: entradaAsiento,
  resumir: (a) => {
    const total = a.lineas.reduce((s, l) => s + aCentavos(l.debe ?? 0), 0n);
    const detalle = a.lineas
      .map((l) => `${l.cuenta} ${l.debe ? `D ${formatoPesos(aCentavos(l.debe))}` : `H ${formatoPesos(aCentavos(l.haber ?? 0))}`}`)
      .join('; ');
    return `Asiento del ${a.fecha} por ${formatoPesos(total)}: "${a.glosa}". ${detalle}`;
  },
  /** Criterio del Contralor sobre un asiento propuesto (además del ensayo en la base). */
  async revisar({ trx, seguridad, agenteCodigo, fecha: hoy }, a) {
    const hallazgos: Hallazgo[] = [];
    const total = a.lineas.reduce((s, l) => s + aCentavos(l.debe ?? 0), 0n);
    const dias = (Date.parse(hoy) - Date.parse(a.fecha)) / 86_400_000;
    if (dias < 0) {
      hallazgos.push({ nivel: 'OBSERVACION', codigo: 'FECHA_FUTURA', mensaje: `El asiento tiene fecha futura (${a.fecha}).` });
    } else if (dias > 60) {
      hallazgos.push({ nivel: 'OBSERVACION', codigo: 'FECHA_ANTIGUA', mensaje: `El asiento es de hace más de 60 días (${a.fecha}): revise que el período corresponda.` });
    }
    const config = await trx
      .selectFrom('agentes_config_empresa')
      .select('parametros')
      .where('empresa_id', '=', seguridad.empresaId)
      .where('agente_codigo', '=', agenteCodigo)
      .executeTakeFirst();
    const umbralConfig = Number((config?.parametros as { umbral_observacion_asiento?: unknown } | undefined)?.umbral_observacion_asiento);
    const umbral = Number.isFinite(umbralConfig) && umbralConfig > 0 ? umbralConfig : UMBRAL_OBSERVACION_ASIENTO;
    if (total >= aCentavos(umbral)) {
      hallazgos.push({
        nivel: 'OBSERVACION',
        codigo: 'MONTO_RELEVANTE',
        mensaje: `El asiento es por ${formatoPesos(total)}, igual o mayor al umbral de revisión de ${formatoPesos(aCentavos(umbral))}.`,
      });
    }
    if (a.glosa.trim().length < 10) {
      hallazgos.push({ nivel: 'OBSERVACION', codigo: 'GLOSA_INSUFICIENTE', mensaje: 'La glosa es muy breve para explicar el asiento.' });
    }
    const cuentasDebe = new Set(a.lineas.filter((l) => aCentavos(l.debe ?? 0) > 0n).map((l) => l.cuenta));
    const mismas = a.lineas.filter((l) => aCentavos(l.haber ?? 0) > 0n && cuentasDebe.has(l.cuenta)).map((l) => l.cuenta);
    if (mismas.length > 0) {
      hallazgos.push({ nivel: 'OBSERVACION', codigo: 'CUENTA_EN_DEBE_Y_HABER', mensaje: `La cuenta ${[...new Set(mismas)].join(', ')} está en el debe y en el haber.` });
    }
    // Un asiento igual (fecha, total y glosa) ya registrado.
    const { rows } = await sql<{ numero: number }>`
      SELECT x.numero FROM asientos x
      WHERE x.empresa_id = ${seguridad.empresaId}::uuid AND x.fecha = ${a.fecha}::date AND x.total = ${deCentavos(total)}::numeric
        AND lower(trim(x.glosa)) = lower(trim(${a.glosa})) AND x.tipo <> 'REVERSA'
        AND NOT EXISTS (SELECT 1 FROM asientos r WHERE r.reversa_de = x.id)
      LIMIT 1`.execute(trx);
    if (rows[0]) {
      hallazgos.push({ nivel: 'OBSERVACION', codigo: 'POSIBLE_DUPLICADO', mensaje: `Ya existe el asiento N° ${rows[0].numero} con la misma fecha, total y glosa.` });
    }
    return hallazgos;
  },
  async ejecutar({ trx, seguridad, propuestaId }, a) {
    const r = await registrarAsiento(trx, {
      empresaId: seguridad.empresaId,
      fecha: a.fecha,
      glosa: a.glosa,
      lineas: a.lineas,
      documentoReferencia: a.documentoReferencia ?? null,
      origen: 'AGENTE',
      propuestaId: propuestaId ?? null,
    });
    return { ...r, total: deCentavos(a.lineas.reduce((s, l) => s + aCentavos(l.debe ?? 0), 0n)) };
  },
};

export const HERRAMIENTAS_CONTABILIDAD = [consultarBalance, consultarMayor, proponerAsiento] as DefinicionHerramienta[];
