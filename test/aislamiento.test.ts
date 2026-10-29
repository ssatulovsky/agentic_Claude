import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextoDeUsuario, enContexto, sinContexto } from '../src/db/conexion.js';
import { permisosEnEmpresa } from '../src/seguridad/permisos.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => {
  await e.cerrar();
});

const cuentas = (usuarioId: string, empresaId: string | null) =>
  enContexto(e.db, contextoDeUsuario(usuarioId, empresaId), (trx) =>
    trx.selectFrom('plan_cuentas').select(['codigo', 'empresa_id']).execute(),
  );

describe('Aislamiento entre empresas garantizado por la base de datos', () => {
  it('el contador ve el plan de cuentas de la empresa que tiene asignada', async () => {
    const filas = await cuentas(e.usuarios.contadorA1.id, e.empresaA1);
    expect(filas.length).toBe(4);
    expect(filas.every((f) => f.empresa_id === e.empresaA1)).toBe(true);
  });

  it('declarar la empresa de OTRO Cliente ERP no muestra nada', async () => {
    expect(await cuentas(e.usuarios.contadorA1.id, e.empresaB1)).toHaveLength(0);
  });

  it('declarar otra empresa del MISMO Cliente ERP sin estar asignado tampoco', async () => {
    expect(await cuentas(e.usuarios.gerenteA1.id, e.empresaA2)).toHaveLength(0);
  });

  it('sin contexto de usuario no se ve ningún dato de negocio', async () => {
    const filas = await sinContexto(e.db, (trx) => trx.selectFrom('plan_cuentas').select('codigo').execute());
    expect(filas).toHaveLength(0);
    const empresas = await sinContexto(e.db, (trx) => trx.selectFrom('empresas').select('id').execute());
    expect(empresas).toHaveLength(0);
  });

  it('no se puede escribir en una empresa ajena aunque se declare como contexto', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaB1), (trx) =>
        trx
          .insertInto('plan_cuentas')
          .values({
            empresa_id: e.empresaB1,
            codigo: '9.9',
            nombre: 'Intrusa',
            clasificacion: 'ACTIVO',
            naturaleza: 'DEUDORA',
            imputable: true,
            padre_id: null,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('el administrador del Cliente ERP ve todas sus empresas y ninguna de otro cliente', async () => {
    const visibles = await enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), async (trx) => {
      const { rows } = await sql<{ id: string }>`SELECT id FROM app_empresas_accesibles()`.execute(trx);
      return rows.map((r) => r.id);
    });
    expect(new Set(visibles)).toEqual(new Set([e.empresaA0, e.empresaA1, e.empresaA2]));
  });

  it('un colaborador con acceso a la empresa no ve el plan de cuentas (no tiene el permiso)', async () => {
    expect(await cuentas(e.usuarios.colaboradorA1.id, e.empresaA1)).toHaveLength(0);
  });

  it('los permisos dependen del rol en cada empresa', async () => {
    const gerente = await enContexto(e.db, contextoDeUsuario(e.usuarios.gerenteA1.id, e.empresaA1), (trx) =>
      permisosEnEmpresa(trx, e.empresaA1),
    );
    expect(gerente.has('contabilidad.plan_cuentas.ver')).toBe(true);
    expect(gerente.has('contabilidad.plan_cuentas.editar')).toBe(false);
    expect(gerente.has('remuneraciones.ver_individual')).toBe(false);
  });

  it('la aplicación no puede leer contraseñas, secretos ni sesiones', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) =>
        sql`SELECT password_hash FROM usuarios`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) =>
        sql`SELECT totp_secreto_cifrado FROM usuarios`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) => sql`SELECT * FROM sesiones`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('un usuario no puede recibir acceso a una empresa de otro Cliente ERP', async () => {
    await expect(
      e.owner.query(`INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, 'CONTADOR')`, [
        e.usuarios.contadorA1.id,
        e.empresaB1,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('el contexto de una transacción no se filtra a la siguiente', async () => {
    await cuentas(e.usuarios.contadorA1.id, e.empresaA1);
    const filas = await sinContexto(e.db, async (trx) => {
      const { rows } = await sql<{ u: string | null }>`SELECT current_setting('app.usuario_id', true) AS u`.execute(trx);
      return rows;
    });
    expect(filas[0]?.u ?? '').toBe('');
  });

  it('la aplicación no puede usar las funciones de autenticación (fabricar sesiones o leer contraseñas)', async () => {
    for (const consulta of [
      sql`SELECT * FROM auth_credenciales('x@y.cl')`,
      sql`SELECT auth_crear_sesion(gen_random_uuid(), '\\x00'::bytea, now(), NULL, NULL)`,
      sql`SELECT auth_marcar_mfa(gen_random_uuid())`,
      sql`SELECT * FROM auth_resolver_sesion('\\x00'::bytea, '1 minute')`,
    ]) {
      await expect(
        enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) => consulta.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('la jerarquía del plan de cuentas no admite ciclos', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), async (trx) => {
        const hija = await trx.selectFrom('plan_cuentas').select('id').where('codigo', '=', '1.1').executeTakeFirstOrThrow();
        await trx.updateTable('plan_cuentas').set({ padre_id: hija.id }).where('codigo', '=', '1').execute();
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('los maestros no se pueden borrar, solo desactivar', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
        sql`DELETE FROM plan_cuentas WHERE codigo = '1.1.02'`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
