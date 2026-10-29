import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listarBitacoraEmpresa, registrarEnBitacora } from '../src/bitacora/bitacora.js';
import { contextoDeUsuario, crearDb, enContexto } from '../src/db/conexion.js';
import { crearBaseDePrueba, eliminarBaseDePrueba } from './preparacionGlobal.js';
import { crearEscenario, type Escenario } from './escenario.js';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => {
  await e.cerrar();
});

describe('Bitácora inmutable', () => {
  it('cada cambio en un maestro queda registrado con antes y después, y el actor', async () => {
    const ctx = contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1);
    await enContexto(e.db, ctx, (trx) =>
      trx.updateTable('plan_cuentas').set({ nombre: 'Caja chica' }).where('codigo', '=', '1.1.01').execute(),
    );
    const eventos = await enContexto(e.db, ctx, (trx) => listarBitacoraEmpresa(trx, e.empresaA1, null, 10));
    const cambio = eventos.find((ev) => ev.accion === 'update' && ev.entidad === 'plan_cuentas');
    expect(cambio).toBeDefined();
    expect(cambio!.actor_tipo).toBe('USUARIO');
    expect(cambio!.actor_id).toBe(e.usuarios.contadorA1.id);
    const datos = cambio!.datos as { antes: { nombre: string }; despues: { nombre: string } };
    expect(datos.antes.nombre).toBe('Caja');
    expect(datos.despues.nombre).toBe('Caja chica');
  });

  it('la aplicación no puede modificar ni borrar eventos', async () => {
    const ctx = contextoDeUsuario(e.usuarios.adminA.id, e.empresaA1);
    await expect(enContexto(e.db, ctx, (trx) => sql`UPDATE bitacora SET accion = 'x'`.execute(trx))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(enContexto(e.db, ctx, (trx) => sql`DELETE FROM bitacora`.execute(trx))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('ni siquiera el dueño de la tabla puede modificar o borrar eventos', async () => {
    await expect(e.owner.query(`UPDATE bitacora SET accion = 'x' WHERE id = (SELECT min(id) FROM bitacora)`)).rejects.toThrow(
      /inmutable/u,
    );
    await expect(e.owner.query('DELETE FROM bitacora')).rejects.toThrow(/inmutable/u);
    await expect(e.owner.query('TRUNCATE bitacora')).rejects.toThrow(/inmutable/u);
  });

  it('un usuario no puede registrar eventos en una empresa a la que no tiene acceso', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1), (trx) =>
        registrarEnBitacora(trx, {
          actorTipo: 'USUARIO',
          actorId: e.usuarios.contadorA1.id,
          accion: 'falso',
          empresaId: e.empresaB1,
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('un usuario no puede registrar eventos a nombre de otro ni como sistema', async () => {
    const ctx = contextoDeUsuario(e.usuarios.contadorA1.id, e.empresaA1);
    await expect(
      enContexto(e.db, ctx, (trx) =>
        registrarEnBitacora(trx, { actorTipo: 'USUARIO', actorId: e.usuarios.adminA.id, accion: 'falso', empresaId: e.empresaA1 }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      enContexto(e.db, ctx, (trx) => registrarEnBitacora(trx, { actorTipo: 'SISTEMA', actorId: 'autenticacion', accion: 'falso' })),
    ).rejects.toMatchObject({ code: '42501' });
    // Sin usuario en la transacción, la aplicación no puede escribir nada.
    await expect(
      e.db.transaction().execute((trx) => registrarEnBitacora(trx, { actorTipo: 'AGENTE', actorId: 'X', accion: 'falso' })),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('sin el permiso bitacora.ver no se ven eventos, aunque se tenga acceso a la empresa', async () => {
    const eventos = await enContexto(e.db, contextoDeUsuario(e.usuarios.colaboradorA1.id, e.empresaA1), (trx) =>
      trx.selectFrom('bitacora').select('id').execute(),
    );
    expect(eventos).toHaveLength(0);
  });

  it('la aplicación no puede verificar la cadena global (operación de plataforma)', async () => {
    await expect(
      enContexto(e.db, contextoDeUsuario(e.usuarios.adminA.id), (trx) => sql`SELECT bitacora_verificar()`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('la cadena de hashes está íntegra', async () => {
    const { rows } = await e.owner.query<{ alterado: string | null }>('SELECT bitacora_verificar() AS alterado');
    expect(rows[0]!.alterado).toBeNull();
  });

  it('dos transacciones concurrentes no bifurcan la cadena, ni siquiera en REPEATABLE READ', async () => {
    const c1 = await e.owner.connect();
    const c2 = await e.owner.connect();
    try {
      await c1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c1.query('SELECT 1'); // fija la foto antes de que escriba la otra transacción
      await c2.query(`SELECT bitacora_registrar('SISTEMA', 'prueba', 'concurrente-2')`);
      // La primera no puede encadenarse a una cabeza que ya cambió: falla en vez de bifurcar.
      await expect(c1.query(`SELECT bitacora_registrar('SISTEMA', 'prueba', 'concurrente-1')`)).rejects.toMatchObject({
        code: '40001',
      });
      await c1.query('ROLLBACK');
    } finally {
      c1.release();
      c2.release();
    }
    const { rows } = await e.owner.query<{ alterado: string | null }>('SELECT bitacora_verificar() AS alterado');
    expect(rows[0]!.alterado).toBeNull();
  });
});

describe('Detección de manipulación', () => {
  // Se usa una base de datos propia: la prueba rompe la cadena a propósito.
  const nombre = `erp_manipulacion_${randomBytes(3).toString('hex')}`;
  let urls: { owner: string; app: string };

  beforeAll(async () => {
    urls = await crearBaseDePrueba(inject('urlAdmin'), nombre);
  });
  afterAll(async () => {
    await eliminarBaseDePrueba(inject('urlAdmin'), nombre);
  });

  it('si alguien con acceso de superusuario altera un evento, la verificación lo detecta', async () => {
    const db = crearDb(urls.app, 2);
    const owner = new pg.Client({ connectionString: urls.owner });
    await owner.connect();
    try {
      for (let i = 0; i < 3; i++) {
        await owner.query(`SELECT bitacora_registrar('SISTEMA', 'prueba', $1)`, [`evento-${i}`]);
      }
      const { rows } = await owner.query<{ id: string }>(`SELECT id FROM bitacora WHERE accion = 'evento-1'`);
      const idAlterado = rows[0]!.id;

      // Un superusuario puede saltarse los triggers; eso es justamente lo que la cadena detecta.
      const urlSuperusuario = new URL(inject('urlAdmin'));
      urlSuperusuario.pathname = `/${nombre}`;
      const admin = new pg.Client({ connectionString: urlSuperusuario.toString() });
      await admin.connect();
      await admin.query('SET session_replication_role = replica');
      await admin.query(`UPDATE bitacora SET datos = '{"monto": 999999}' WHERE id = $1`, [idAlterado]);
      await admin.end();

      const { rows: verif } = await owner.query<{ alterado: string | null }>('SELECT bitacora_verificar() AS alterado');
      expect(verif[0]!.alterado).toBe(idAlterado);
    } finally {
      await owner.end();
      await db.destroy();
    }
  });
});
