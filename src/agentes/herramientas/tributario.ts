import { sql } from 'kysely';
import { z } from 'zod';
import { listarF29, obtenerF29, prepararF29 } from '../../tributario/f29.js';
import { resumenRcv } from '../../tributario/rcv.js';
import type { DefinicionHerramienta } from '../tipos.js';

const periodo = {
  anio: z.number().int().min(2000).max(2100).describe('Año del período tributario'),
  mes: z.number().int().min(1).max(12).describe('Mes del período tributario (1 a 12)'),
};

export const consultarRcv: DefinicionHerramienta<{ anio: number; mes: number }, unknown> = {
  nombre: 'consultar_rcv',
  descripcion:
    'Resumen del Registro de Compras y Ventas importado del SII para un mes: totales de compras y ventas por tipo de documento y sección (registro, pendientes, reclamados).',
  modulo: 'TRIBUTARIO',
  permiso: 'tributario.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object(periodo),
  ejecutar: ({ trx, seguridad }, e) => resumenRcv(trx, seguridad.empresaId, e.anio, e.mes),
};

export const consultarF29: DefinicionHerramienta<{ anio: number; mes: number }, unknown> = {
  nombre: 'consultar_f29',
  descripcion:
    'Propuestas de F29 de un mes (todas sus versiones y estados) y el detalle por código de la más reciente: IVA determinado, remanente, PPM, retenciones y total a pagar, con sus advertencias.',
  modulo: 'TRIBUTARIO',
  permiso: 'tributario.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object(periodo),
  async ejecutar({ trx, seguridad }, e) {
    const versiones = await listarF29(trx, seguridad.empresaId, e.anio, e.mes);
    const ultima = versiones[0];
    return {
      versiones,
      detalle: ultima ? await obtenerF29(trx, seguridad.empresaId, ultima.id) : null,
    };
  },
};

export const prepararF29Agente: DefinicionHerramienta<
  { anio: number; mes: number; remanenteAnterior?: number; factorProporcionalidad?: number },
  unknown
> = {
  nombre: 'preparar_f29',
  descripcion:
    'Prepara una propuesta (borrador) de F29 de un mes a partir del RCV importado, la tasa de PPM y el remanente anterior. No declara nada ante el SII: una persona la revisa y aprueba. El remanente anterior solo se indica si no hay un F29 del mes anterior en el sistema, y debe venir del usuario.',
  modulo: 'TRIBUTARIO',
  permiso: 'tributario.f29.preparar',
  autonomia: 'EJECUTAR_CON_AVISO',
  entrada: z.object({
    ...periodo,
    remanenteAnterior: z
      .number()
      .int()
      .nonnegative()
      .max(999_999_999_999)
      .optional()
      .describe('Código 77 del F29 del mes anterior, en pesos, informado por el usuario'),
    factorProporcionalidad: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Factor de proporcionalidad del IVA de uso común, informado por el contador'),
  }),
  async ejecutar({ trx, seguridad, propuestaId }, e) {
    // Si una persona aprobó la propuesta del agente, el F29 queda con origen AGENTE_APROBADO.
    if (propuestaId) await sql`SELECT set_config('app.propuesta_agente', ${propuestaId}, true)`.execute(trx);
    const id = await prepararF29(trx, { empresaId: seguridad.empresaId, ...e });
    return obtenerF29(trx, seguridad.empresaId, id);
  },
  resumir: (e) => `Preparar la propuesta de F29 de ${String(e.mes).padStart(2, '0')}-${e.anio}`,
};

export const HERRAMIENTAS_TRIBUTARIO: DefinicionHerramienta[] = [
  consultarRcv,
  consultarF29,
  prepararF29Agente,
] as DefinicionHerramienta[];
