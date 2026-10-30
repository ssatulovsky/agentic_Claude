import { sql } from 'kysely';
import { z } from 'zod';
import { conciliar, contabilizarMovimiento, informeConciliacion, listarCuentasBancarias, sugerirConciliacion } from '../../tesoreria/conciliacion.js';
import type { DefinicionHerramienta } from '../tipos.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe('Fecha AAAA-MM-DD');
const cuentaId = z.uuid().describe('Id de la cuenta bancaria (ver consultar_cuentas_bancarias)');

export const consultarCuentasBancarias: DefinicionHerramienta<Record<string, never>, unknown> = {
  nombre: 'consultar_cuentas_bancarias',
  descripcion: 'Cuentas bancarias de la empresa, con su banco, número y cuenta contable asociada.',
  modulo: 'TESORERIA',
  permiso: 'tesoreria.saldos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({}),
  ejecutar: ({ trx, seguridad }) => listarCuentasBancarias(trx, seguridad.empresaId),
};

export const consultarConciliacion: DefinicionHerramienta<{ cuentaId: string; corte: string }, unknown> = {
  nombre: 'consultar_conciliacion_bancaria',
  descripcion:
    'Conciliación bancaria de una cuenta a una fecha: saldo según el banco, saldo según la contabilidad, movimientos del banco sin contabilizar, partidas contables que aún no pasan por el banco, diferencia y advertencias.',
  modulo: 'TESORERIA',
  permiso: 'tesoreria.saldos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ cuentaId, corte: fecha }),
  async ejecutar({ trx, seguridad }, e) {
    const r = await informeConciliacion(trx, seguridad.empresaId, e.cuentaId, e.corte);
    return {
      ...r,
      movimientosNoContabilizados: r.movimientosNoContabilizados.slice(0, 100),
      partidasNoCobradasEnBanco: r.partidasNoCobradasEnBanco.slice(0, 100),
    };
  },
};

export const sugerirConciliacionAgente: DefinicionHerramienta<{ cuentaId: string; hasta: string }, unknown> = {
  nombre: 'sugerir_conciliacion',
  descripcion:
    'Para cada movimiento del banco pendiente hasta una fecha, sugiere conciliarlo con un asiento del mismo monto o contabilizarlo según una regla, con documentos del RCV como evidencia. No modifica nada.',
  modulo: 'TESORERIA',
  permiso: 'tesoreria.saldos.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ cuentaId, hasta: fecha }),
  async ejecutar({ trx, seguridad }, e) {
    const r = await sugerirConciliacion(trx, seguridad.empresaId, e.cuentaId, e.hasta);
    return { ...r, movimientos: r.movimientos.slice(0, 100), sugerencias: r.sugerencias.slice(0, 100) };
  },
};

const marcarPropuesta = async (trx: Parameters<DefinicionHerramienta['ejecutar']>[0]['trx'], propuestaId?: string) => {
  if (propuestaId) await sql`SELECT set_config('app.propuesta_agente', ${propuestaId}, true)`.execute(trx);
};

export const proponerConciliar: DefinicionHerramienta<{ movimientos: number[]; lineas: number[] }, unknown> = {
  nombre: 'proponer_conciliar',
  descripcion: 'Propone conciliar movimientos del banco con líneas contables de la cuenta del banco cuyo neto sea el mismo. Lo aprueba una persona.',
  modulo: 'TESORERIA',
  permiso: 'tesoreria.conciliar',
  autonomia: 'PROPONER',
  entrada: z.object({
    movimientos: z.array(z.number().int().positive()).min(1).max(50),
    lineas: z.array(z.number().int().positive()).min(1).max(50),
  }),
  async ejecutar({ trx, seguridad, propuestaId }, e) {
    await marcarPropuesta(trx, propuestaId);
    return { conciliacionId: await conciliar(trx, seguridad.empresaId, e.movimientos, e.lineas) };
  },
  resumir: (e) => `Conciliar ${e.movimientos.length} movimiento(s) del banco con ${e.lineas.length} línea(s) contable(s)`,
};

export const proponerContabilizarMovimiento: DefinicionHerramienta<
  { movimientoId: number; cuentaContable: string; tercero?: string; glosa: string },
  unknown
> = {
  nombre: 'proponer_contabilizar_movimiento',
  descripcion:
    'Propone registrar el asiento de un movimiento del banco contra una cuenta contable (por ejemplo, la que indica una regla) y conciliarlo. Lo aprueba una persona.',
  modulo: 'TESORERIA',
  permiso: 'tesoreria.conciliar',
  autonomia: 'PROPONER',
  entrada: z.object({
    movimientoId: z.number().int().positive(),
    cuentaContable: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u),
    tercero: z.string().regex(/^\d{1,8}-[\dkK]$/u).optional().describe('RUT del tercero, si la cuenta lo exige'),
    glosa: z.string().min(5).max(300),
  }),
  async ejecutar({ trx, seguridad, propuestaId }, e) {
    return contabilizarMovimiento(trx, { empresaId: seguridad.empresaId, ...e, propuestaId });
  },
  resumir: (e) => `Contabilizar el movimiento ${e.movimientoId} contra la cuenta ${e.cuentaContable}: ${e.glosa}`,
};

export const HERRAMIENTAS_TESORERIA: DefinicionHerramienta[] = [
  consultarCuentasBancarias,
  consultarConciliacion,
  sugerirConciliacionAgente,
  proponerConciliar,
  proponerContabilizarMovimiento,
] as DefinicionHerramienta[];
