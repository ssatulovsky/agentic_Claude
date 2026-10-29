import { z } from 'zod';
import { registrarAsiento } from '../../contabilidad/libroDiario.js';
import { balanceOchoColumnas, libroMayor } from '../../contabilidad/reportes.js';
import { aCentavos, deCentavos, formatoPesos } from '../../utilidades/montos.js';
import type { DefinicionHerramienta } from '../tipos.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe('Fecha AAAA-MM-DD');
const monto = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/u)])
  .describe('Monto en pesos, con hasta 2 decimales');

export const consultarBalance: DefinicionHerramienta<{ desde: string; hasta: string }, unknown> = {
  nombre: 'consultar_balance',
  descripcion:
    'Balance de 8 columnas (comprobación y saldos) entre dos fechas: débitos, créditos, saldos, inventario, resultados y resultado del ejercicio.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.asientos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ desde: fecha, hasta: fecha }),
  async ejecutar({ trx, seguridad }, e) {
    const b = await balanceOchoColumnas(trx, seguridad.empresaId, e.desde, e.hasta);
    return { ...b, filas: b.filas.slice(0, 200), filasOmitidas: Math.max(b.filas.length - 200, 0) };
  },
};

export const consultarMayor: DefinicionHerramienta<{ cuenta: string; desde: string; hasta: string }, unknown> = {
  nombre: 'consultar_mayor',
  descripcion: 'Libro mayor de una cuenta: saldo inicial, movimientos y saldo final entre dos fechas.',
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
