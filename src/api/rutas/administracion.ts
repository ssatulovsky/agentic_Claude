import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registrarEnBitacora } from '../../bitacora/bitacora.js';
import { contextoDeUsuario, enContexto } from '../../db/conexion.js';
import { ErrorNegocio } from '../../errores.js';
import { evaluarContrasena, hashearContrasena } from '../../seguridad/contrasenas.js';
import { exigirPermiso, exigirPermisoCliente, permisosEnEmpresa } from '../../seguridad/permisos.js';
import { normalizarRut, rutEsValido } from '../../utilidades/rut.js';
import { exigirSesion, paramEmpresa, validar, type Dependencias } from '../servidor.js';

const rut = z
  .string()
  .transform(normalizarRut)
  .refine(rutEsValido, 'RUT inválido');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha en formato AAAA-MM-DD');

const cuerpoEmpresa = z.object({
  rut,
  razonSocial: z.string().trim().min(2).max(200),
  giro: z.string().trim().max(200).optional(),
  tipo: z.enum(['PROPIA', 'ANCLA']),
});

const cuerpoSuscripcion = z.object({
  modulo: z.string().regex(/^[A-Z_]+$/u),
  pagador: z.enum(['CLIENTE_ERP', 'EMPRESA']),
  vigenteDesde: fecha,
  vigenteHasta: fecha.optional(),
});

const cuerpoUsuario = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  nombre: z.string().trim().min(2).max(150),
  contrasenaTemporal: z.string().min(1).max(200),
  telefonoWhatsapp: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/u, 'Teléfono en formato internacional, p. ej. +56912345678')
    .optional(),
});

const cuerpoMembresia = z.union([
  z.object({ alcance: z.literal('EMPRESA'), empresaId: z.uuid(), rol: z.string().regex(/^[A-Z_]+$/u) }),
  z.object({ alcance: z.literal('CLIENTE_ERP'), rol: z.string().regex(/^[A-Z_]+$/u) }),
]);

export async function rutasAdministracion(app: FastifyInstance, deps: Dependencias): Promise<void> {
  app.addHook('preHandler', exigirSesion(deps));

  /** Crea una empresa (la propia o un cliente ancla) dentro del Cliente ERP. */
  app.post('/empresas', async (req, reply) => {
    const sesion = req.sesion!;
    const datos = validar(cuerpoEmpresa, req.body);
    const empresa = await enContexto(deps.db, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await exigirPermisoCliente(trx, 'empresas.administrar');
      // Sin RETURNING: la política de lectura evalúa el acceso con la foto previa a la
      // inserción, así que la fila nueva se lee en una consulta aparte.
      const id = randomUUID();
      await trx
        .insertInto('empresas')
        .values({
          id,
          cliente_erp_id: sesion.clienteErpId,
          rut: datos.rut,
          razon_social: datos.razonSocial,
          giro: datos.giro ?? null,
          tipo: datos.tipo,
        })
        .execute();
      const creada = await trx
        .selectFrom('empresas')
        .select(['id', 'rut', 'razon_social', 'tipo', 'estado'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      await registrarEnBitacora(trx, {
        actorTipo: 'USUARIO',
        actorId: sesion.usuarioId,
        accion: 'empresa.creada',
        entidad: 'empresas',
        entidadId: creada.id,
        datos: { rut: creada.rut, razon_social: creada.razon_social, tipo: creada.tipo },
        empresaId: creada.id,
      });
      return creada;
    });
    return reply.status(201).send(empresa);
  });

  /** Permisos efectivos del usuario en una empresa (para que la interfaz muestre lo que corresponde). */
  app.get('/empresas/:empresaId/permisos', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const sesion = req.sesion!;
    return enContexto(deps.db, contextoDeUsuario(sesion.usuarioId, empresaId), async (trx) => {
      const permisos = [...(await permisosEnEmpresa(trx, empresaId))].sort();
      if (permisos.length === 0) {
        throw new ErrorNegocio('NO_ENCONTRADO', 'La empresa no existe o no tiene acceso.', 404);
      }
      return { empresaId, permisos };
    });
  });

  app.get('/empresas/:empresaId/suscripciones', async (req) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    return enContexto(deps.db, contextoDeUsuario(req.sesion!.usuarioId, empresaId), async (trx) => {
      await exigirPermiso(trx, empresaId, 'empresas.ver');
      return trx
        .selectFrom('suscripciones_modulo')
        .select(['id', 'modulo_codigo', 'pagador', 'vigente_desde', 'vigente_hasta'])
        .where('empresa_id', '=', empresaId)
        .orderBy('modulo_codigo')
        .execute();
    });
  });

  app.post('/empresas/:empresaId/suscripciones', async (req, reply) => {
    const { empresaId } = validar(paramEmpresa, req.params);
    const datos = validar(cuerpoSuscripcion, req.body);
    const sesion = req.sesion!;
    const creada = await enContexto(deps.db, contextoDeUsuario(sesion.usuarioId, empresaId), async (trx) => {
      await exigirPermisoCliente(trx, 'empresas.administrar');
      const fila = await trx
        .insertInto('suscripciones_modulo')
        .values({
          empresa_id: empresaId,
          modulo_codigo: datos.modulo,
          pagador: datos.pagador,
          vigente_desde: datos.vigenteDesde,
          vigente_hasta: datos.vigenteHasta ?? null,
        })
        .returning(['id', 'modulo_codigo', 'pagador', 'vigente_desde', 'vigente_hasta'])
        .executeTakeFirstOrThrow();
      await registrarEnBitacora(trx, {
        actorTipo: 'USUARIO',
        actorId: sesion.usuarioId,
        accion: 'suscripcion.creada',
        entidad: 'suscripciones_modulo',
        entidadId: fila.id,
        datos: { ...fila },
        empresaId,
      });
      return fila;
    });
    return reply.status(201).send(creada);
  });

  /** Crea un usuario con contraseña temporal. Al ingresar deberá enrolar el doble factor. */
  app.post('/usuarios', async (req, reply) => {
    const sesion = req.sesion!;
    const datos = validar(cuerpoUsuario, req.body);
    const politica = evaluarContrasena(datos.contrasenaTemporal, datos.email);
    if (!politica.valida) {
      throw new ErrorNegocio('CONTRASENA_DEBIL', 'La contraseña no cumple la política.', 422, politica.motivos);
    }
    const hash = await hashearContrasena(datos.contrasenaTemporal);
    const usuario = await enContexto(deps.db, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await exigirPermisoCliente(trx, 'usuarios.administrar');
      const creado = await trx
        .insertInto('usuarios')
        .values({
          cliente_erp_id: sesion.clienteErpId,
          email: datos.email,
          nombre: datos.nombre,
          password_hash: hash,
          telefono_whatsapp: datos.telefonoWhatsapp ?? null,
        })
        .returning(['id', 'email', 'nombre'])
        .executeTakeFirstOrThrow();
      await registrarEnBitacora(trx, {
        actorTipo: 'USUARIO',
        actorId: sesion.usuarioId,
        accion: 'usuario.creado',
        entidad: 'usuarios',
        entidadId: creado.id,
        datos: { email: creado.email, nombre: creado.nombre },
      });
      return creado;
    });
    return reply.status(201).send(usuario);
  });

  app.post('/usuarios/:usuarioId/membresias', async (req, reply) => {
    const { usuarioId } = validar(z.object({ usuarioId: z.uuid() }), req.params);
    const datos = validar(cuerpoMembresia, req.body);
    const sesion = req.sesion!;
    await enContexto(deps.db, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await exigirPermisoCliente(trx, 'usuarios.administrar');
      if (datos.alcance === 'EMPRESA') {
        await trx
          .insertInto('membresias_empresa')
          .values({ usuario_id: usuarioId, empresa_id: datos.empresaId, rol_codigo: datos.rol })
          .execute();
      } else {
        await trx
          .insertInto('membresias_cliente_erp')
          .values({ usuario_id: usuarioId, cliente_erp_id: sesion.clienteErpId, rol_codigo: datos.rol })
          .execute();
      }
      await registrarEnBitacora(trx, {
        actorTipo: 'USUARIO',
        actorId: sesion.usuarioId,
        accion: 'membresia.asignada',
        entidad: 'usuarios',
        entidadId: usuarioId,
        datos: { ...datos },
        empresaId: datos.alcance === 'EMPRESA' ? datos.empresaId : null,
      });
    });
    return reply.status(201).send({ asignada: true });
  });
}
