import { z } from 'zod';
import { ErrorNegocio } from '../../errores.js';
import { calcularImpuestoUnicoMensual, obtenerIndicador, obtenerParametro } from '../../normativa/normativa.js';
import type { DefinicionHerramienta } from '../tipos.js';

/**
 * Herramientas de la Fase 0. Cada una llama al núcleo con la identidad de la
 * persona que consulta: la base de datos filtra lo que esa persona puede ver.
 */

export const consultarPlanCuentas: DefinicionHerramienta<
  { texto?: string | undefined; clasificacion?: string | undefined; soloImputables?: boolean | undefined },
  unknown
> = {
  nombre: 'consultar_plan_cuentas',
  descripcion:
    'Busca cuentas del plan de cuentas de la empresa por código o nombre. Devuelve como máximo 50 cuentas activas.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.plan_cuentas.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({
    texto: z.string().max(100).optional().describe('Parte del código o del nombre de la cuenta'),
    clasificacion: z.enum(['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'ORDEN']).optional(),
    soloImputables: z.boolean().optional(),
  }),
  async ejecutar({ trx, seguridad }, entrada) {
    let consulta = trx
      .selectFrom('plan_cuentas')
      .select(['codigo', 'nombre', 'clasificacion', 'naturaleza', 'imputable'])
      .where('empresa_id', '=', seguridad.empresaId)
      .where('activa', '=', true)
      .orderBy('codigo')
      .limit(50);
    if (entrada.texto) {
      const patron = `%${entrada.texto.replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;
      consulta = consulta.where((eb) => eb.or([eb('codigo', 'like', patron), eb('nombre', 'ilike', patron)]));
    }
    if (entrada.clasificacion) {
      consulta = consulta.where('clasificacion', '=', entrada.clasificacion as never);
    }
    if (entrada.soloImputables) {
      consulta = consulta.where('imputable', '=', true);
    }
    const cuentas = await consulta.execute();
    return { cantidad: cuentas.length, cuentas };
  },
};

export const buscarTercero: DefinicionHerramienta<{ texto: string }, unknown> = {
  nombre: 'buscar_tercero',
  descripcion: 'Busca clientes, proveedores, trabajadores o prestadores a honorarios por RUT o razón social.',
  modulo: null,
  permiso: 'maestros.terceros.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ texto: z.string().min(2).max(100).describe('RUT (con o sin puntos) o parte de la razón social') }),
  async ejecutar({ trx, seguridad }, entrada) {
    const rut = entrada.texto.replace(/\./gu, '').toUpperCase();
    const patron = `%${entrada.texto.replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;
    const terceros = await trx
      .selectFrom('terceros')
      .select(['rut', 'razon_social', 'es_cliente', 'es_proveedor', 'es_trabajador', 'es_honorarios', 'activo'])
      .where('empresa_id', '=', seguridad.empresaId)
      .where((eb) => eb.or([eb('rut', '=', rut), eb('razon_social', 'ilike', patron)]))
      .orderBy('razon_social')
      .limit(20)
      .execute();
    return { cantidad: terceros.length, terceros };
  },
};

export const consultarParametroLegal: DefinicionHerramienta<{ clave: string; fecha: string }, unknown> = {
  nombre: 'consultar_parametro_legal',
  descripcion:
    'Devuelve el valor oficial vigente de un parámetro legal (por ejemplo TOPE_IMPONIBLE.AFP_SALUD o IMM.GENERAL) en una fecha, con su fuente.',
  modulo: null,
  permiso: 'normativa.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({
    clave: z.string().regex(/^[A-Z0-9_.]+$/u).describe('Clave del parámetro, en mayúsculas'),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe('Fecha de referencia AAAA-MM-DD'),
  }),
  async ejecutar({ trx }, entrada) {
    return obtenerParametro(trx, entrada.clave, entrada.fecha);
  },
};

export const calcularImpuestoUnico: DefinicionHerramienta<{ rentaLiquidaImponible: number; fecha: string }, unknown> = {
  nombre: 'calcular_impuesto_unico',
  descripcion:
    'Calcula el impuesto único de segunda categoría mensual para una renta líquida imponible en pesos, con la tabla y UTM vigentes en la fecha.',
  modulo: null,
  permiso: 'normativa.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({
    rentaLiquidaImponible: z.number().int().nonnegative().describe('Renta líquida imponible del mes, en pesos'),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  }),
  async ejecutar({ trx }, entrada) {
    return calcularImpuestoUnicoMensual(trx, entrada.rentaLiquidaImponible, entrada.fecha);
  },
};

export const consultarIndicador: DefinicionHerramienta<{ tipo: 'UF' | 'UTM' | 'UTA'; fecha: string }, unknown> = {
  nombre: 'consultar_indicador',
  descripcion: 'Devuelve el valor oficial de la UF (diaria), UTM o UTA (mensuales) en una fecha.',
  modulo: null,
  permiso: 'normativa.ver',
  autonomia: 'CONSULTAR',
  entrada: z.object({ tipo: z.enum(['UF', 'UTM', 'UTA']), fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }),
  async ejecutar({ trx }, entrada) {
    return obtenerIndicador(trx, entrada.tipo, entrada.fecha);
  },
};

const entradaCuenta = z.object({
  codigo: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u).describe('Código jerárquico, p. ej. 1.1.01.003'),
  nombre: z.string().min(3).max(150),
  clasificacion: z.enum(['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'ORDEN']),
  naturaleza: z.enum(['DEUDORA', 'ACREEDORA']),
  imputable: z.boolean(),
  codigoPadre: z.string().regex(/^[0-9]+(\.[0-9]+)*$/u).optional().describe('Código de la cuenta de agrupación'),
  motivo: z.string().min(5).max(500).describe('Por qué se necesita la cuenta'),
});

export const proponerCuentaContable: DefinicionHerramienta<z.infer<typeof entradaCuenta>, unknown> = {
  nombre: 'proponer_cuenta_contable',
  descripcion:
    'Propone crear una cuenta nueva en el plan de cuentas. No la crea: queda pendiente hasta que una persona autorizada la apruebe.',
  modulo: 'CONTABILIDAD',
  permiso: 'contabilidad.plan_cuentas.editar',
  autonomia: 'PROPONER',
  entrada: entradaCuenta,
  resumir: (e) => `Crear cuenta ${e.codigo} "${e.nombre}" (${e.clasificacion}, ${e.naturaleza}). Motivo: ${e.motivo}`,
  async ejecutar({ trx, seguridad }, entrada) {
    let padreId: string | null = null;
    if (entrada.codigoPadre) {
      const padre = await trx
        .selectFrom('plan_cuentas')
        .select('id')
        .where('empresa_id', '=', seguridad.empresaId)
        .where('codigo', '=', entrada.codigoPadre)
        .executeTakeFirst();
      if (!padre) {
        throw new ErrorNegocio('CUENTA_PADRE_INEXISTENTE', `La cuenta padre ${entrada.codigoPadre} no existe.`, 422);
      }
      padreId = padre.id;
    }
    const creada = await trx
      .insertInto('plan_cuentas')
      .values({
        empresa_id: seguridad.empresaId,
        codigo: entrada.codigo,
        nombre: entrada.nombre,
        clasificacion: entrada.clasificacion,
        naturaleza: entrada.naturaleza,
        imputable: entrada.imputable,
        padre_id: padreId,
      })
      .returning(['id', 'codigo', 'nombre'])
      .executeTakeFirstOrThrow();
    return creada;
  },
};

export const HERRAMIENTAS_FASE_0 = [
  consultarPlanCuentas,
  buscarTercero,
  consultarParametroLegal,
  consultarIndicador,
  calcularImpuestoUnico,
  proponerCuentaContable,
] as DefinicionHerramienta[];
