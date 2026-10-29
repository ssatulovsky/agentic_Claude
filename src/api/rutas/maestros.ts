import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { ErrorNegocio, noEncontrado } from '../../errores.js';
import { exigirPermiso } from '../../seguridad/permisos.js';
import { normalizarRut, rutEsValido } from '../../utilidades/rut.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const codigoCuenta = z.string().regex(/^[0-9]+(\.[0-9]+)*$/u, 'Código jerárquico, p. ej. 1.1.01');

const cuerpoCuenta = z.object({
  codigo: codigoCuenta,
  nombre: z.string().trim().min(2).max(150),
  clasificacion: z.enum(['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'ORDEN']),
  naturaleza: z.enum(['DEUDORA', 'ACREEDORA']),
  imputable: z.boolean(),
  codigoPadre: codigoCuenta.optional(),
  requiereTercero: z.boolean().optional(),
  requiereCentroCosto: z.boolean().optional(),
});

const cambioCuenta = z
  .object({
    nombre: z.string().trim().min(2).max(150).optional(),
    requiereTercero: z.boolean().optional(),
    requiereCentroCosto: z.boolean().optional(),
    activa: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'Indique al menos un cambio');

const cuerpoTercero = z.object({
  rut: z.string().transform(normalizarRut).refine(rutEsValido, 'RUT inválido'),
  razonSocial: z.string().trim().min(2).max(200),
  esCliente: z.boolean().default(false),
  esProveedor: z.boolean().default(false),
  esTrabajador: z.boolean().default(false),
  esHonorarios: z.boolean().default(false),
  email: z.string().trim().toLowerCase().email().optional(),
  telefono: z.string().trim().max(30).optional(),
});

const cuerpoCentroCosto = z.object({
  codigo: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/u),
  nombre: z.string().trim().min(2).max(150),
});

export async function rutasMaestros(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));
  const ctx = (usuarioId: string, empresaId: string) => contextoDeUsuario(usuarioId, empresaId);

  // ---------------- Plan de cuentas ----------------
  app.get('/empresas/:empresaId/plan-cuentas', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.plan_cuentas.ver');
      return trx
        .selectFrom('plan_cuentas')
        .select([
          'id',
          'codigo',
          'nombre',
          'clasificacion',
          'naturaleza',
          'imputable',
          'padre_id',
          'requiere_tercero',
          'requiere_centro_costo',
          'activa',
        ])
        .where('empresa_id', '=', empresaId)
        .orderBy('codigo')
        .execute();
    });
  });

  app.post('/empresas/:empresaId/plan-cuentas', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const datos = validar(cuerpoCuenta, req.body);
    const creada = await enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.plan_cuentas.editar');
      let padreId: string | null = null;
      if (datos.codigoPadre) {
        const padre = await trx
          .selectFrom('plan_cuentas')
          .select('id')
          .where('empresa_id', '=', empresaId)
          .where('codigo', '=', datos.codigoPadre)
          .executeTakeFirst();
        if (!padre) throw new ErrorNegocio('CUENTA_PADRE_INEXISTENTE', `La cuenta ${datos.codigoPadre} no existe.`, 422);
        padreId = padre.id;
      }
      return trx
        .insertInto('plan_cuentas')
        .values({
          empresa_id: empresaId,
          codigo: datos.codigo,
          nombre: datos.nombre,
          clasificacion: datos.clasificacion,
          naturaleza: datos.naturaleza,
          imputable: datos.imputable,
          padre_id: padreId,
          requiere_tercero: datos.requiereTercero ?? false,
          requiere_centro_costo: datos.requiereCentroCosto ?? false,
        })
        .returning(['id', 'codigo', 'nombre'])
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(creada);
  });

  app.patch('/empresas/:empresaId/plan-cuentas/:cuentaId', async (req) => {
    const { empresaId, cuentaId } = validar(paramEmpresa.extend({ cuentaId: z.uuid() }), req.params);
    const cambios = validar(cambioCuenta, req.body);
    return enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'contabilidad.plan_cuentas.editar');
      const actualizada = await trx
        .updateTable('plan_cuentas')
        .set({
          ...(cambios.nombre !== undefined && { nombre: cambios.nombre }),
          ...(cambios.requiereTercero !== undefined && { requiere_tercero: cambios.requiereTercero }),
          ...(cambios.requiereCentroCosto !== undefined && { requiere_centro_costo: cambios.requiereCentroCosto }),
          ...(cambios.activa !== undefined && { activa: cambios.activa }),
        })
        .where('id', '=', cuentaId)
        .where('empresa_id', '=', empresaId)
        .returning(['id', 'codigo', 'nombre', 'activa'])
        .executeTakeFirst();
      if (!actualizada) throw noEncontrado('La cuenta');
      return actualizada;
    });
  });

  // ---------------- Terceros ----------------
  app.get('/empresas/:empresaId/terceros', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'maestros.terceros.ver');
      return trx
        .selectFrom('terceros')
        .select(['id', 'rut', 'razon_social', 'es_cliente', 'es_proveedor', 'es_trabajador', 'es_honorarios', 'activo'])
        .where('empresa_id', '=', empresaId)
        .orderBy('razon_social')
        .execute();
    });
  });

  app.post('/empresas/:empresaId/terceros', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(cuerpoTercero, req.body);
    const creado = await enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'maestros.terceros.editar');
      return trx
        .insertInto('terceros')
        .values({
          empresa_id: empresaId,
          rut: d.rut,
          razon_social: d.razonSocial,
          es_cliente: d.esCliente,
          es_proveedor: d.esProveedor,
          es_trabajador: d.esTrabajador,
          es_honorarios: d.esHonorarios,
          email: d.email ?? null,
          telefono: d.telefono ?? null,
        })
        .returning(['id', 'rut', 'razon_social'])
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(creado);
  });

  // ---------------- Centros de costo ----------------
  app.get('/empresas/:empresaId/centros-costo', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'maestros.centros_costo.ver');
      return trx
        .selectFrom('centros_costo')
        .select(['id', 'codigo', 'nombre', 'activo'])
        .where('empresa_id', '=', empresaId)
        .orderBy('codigo')
        .execute();
    });
  });

  app.post('/empresas/:empresaId/centros-costo', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const d = validar(cuerpoCentroCosto, req.body);
    const creado = await enContexto(deps.db, ctx(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'maestros.centros_costo.editar');
      return trx
        .insertInto('centros_costo')
        .values({ empresa_id: empresaId, codigo: d.codigo, nombre: d.nombre })
        .returning(['id', 'codigo', 'nombre'])
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(creado);
  });
}
