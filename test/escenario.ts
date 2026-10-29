import { randomInt } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { crearDb, type Db } from '../src/db/conexion.js';
import { Cifrador } from '../src/seguridad/cifrado.js';
import { hashearContrasena } from '../src/seguridad/contrasenas.js';
import { generarSecretoTotp } from '../src/seguridad/totp.js';
import { CLAVE_PRUEBAS } from './preparacionGlobal.js';

export const CONTRASENA = 'Prueba-Segura-2026!';

/** Genera un RUT válido aleatorio (para que cada prueba tenga datos propios). */
export function rutAleatorio(): string {
  const cuerpo = String(randomInt(10_000_000, 99_999_999));
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  return `${cuerpo}-${resto === 11 ? '0' : resto === 10 ? 'K' : String(resto)}`;
}

export interface UsuarioPrueba {
  id: string;
  email: string;
  totpSecreto: string | null;
}

export interface Escenario {
  owner: pg.Pool;
  db: Db;
  /** Conexión del servicio de autenticación (rol erp_auth). */
  dbAuth: Db;
  cifrador: Cifrador;
  clienteA: string;
  clienteB: string;
  /** Empresa propia del Cliente ERP A. */
  empresaA0: string;
  /** Cliente ancla A1, con módulo CONTABILIDAD contratado. */
  empresaA1: string;
  /** Cliente ancla A2, sin módulos contratados. */
  empresaA2: string;
  empresaB1: string;
  usuarios: {
    adminA: UsuarioPrueba;
    contadorA1: UsuarioPrueba;
    gerenteA1: UsuarioPrueba;
    colaboradorA1: UsuarioPrueba;
    nuevoSinMfa: UsuarioPrueba;
    adminB: UsuarioPrueba;
  };
  cerrar: () => Promise<void>;
}

/**
 * Dos Clientes ERP independientes (A y B). A tiene su empresa propia y dos
 * clientes ancla; B tiene una empresa. Usuarios con distintos perfiles en A.
 */
export async function crearEscenario(): Promise<Escenario> {
  const owner = new pg.Pool({ connectionString: inject('urlOwner'), max: 3 });
  const db = crearDb(inject('urlApp'), 5);
  const dbAuth = crearDb(inject('urlAuth'), 5);
  const cifrador = new Cifrador(CLAVE_PRUEBAS);
  const hash = await hashearContrasena(CONTRASENA);
  const sufijo = randomInt(1_000_000).toString(36);

  const uno = async <T extends pg.QueryResultRow>(texto: string, valores: unknown[]): Promise<T> =>
    (await owner.query<T>(texto, valores)).rows[0]!;

  const clienteA = (await uno<{ id: string }>('INSERT INTO clientes_erp (rut, razon_social) VALUES ($1, $2) RETURNING id', [rutAleatorio(), `Estudio A ${sufijo}`])).id;
  const clienteB = (await uno<{ id: string }>('INSERT INTO clientes_erp (rut, razon_social) VALUES ($1, $2) RETURNING id', [rutAleatorio(), `Estudio B ${sufijo}`])).id;

  const empresa = async (cliente: string, nombre: string, tipo: 'PROPIA' | 'ANCLA') =>
    (await uno<{ id: string }>('INSERT INTO empresas (cliente_erp_id, rut, razon_social, tipo) VALUES ($1, $2, $3, $4) RETURNING id', [cliente, rutAleatorio(), nombre, tipo])).id;

  const empresaA0 = await empresa(clienteA, 'Estudio A propia', 'PROPIA');
  const empresaA1 = await empresa(clienteA, 'Pesquera Ancla A1', 'ANCLA');
  const empresaA2 = await empresa(clienteA, 'Constructora Ancla A2', 'ANCLA');
  const empresaB1 = await empresa(clienteB, 'Empresa B1', 'PROPIA');

  for (const e of [empresaA0, empresaA1, empresaB1]) {
    await owner.query(
      `INSERT INTO suscripciones_modulo (empresa_id, modulo_codigo, pagador, vigente_desde) VALUES ($1, 'CONTABILIDAD', 'CLIENTE_ERP', '2026-01-01')`,
      [e],
    );
  }

  const usuario = async (cliente: string, etiqueta: string, conMfa = true): Promise<UsuarioPrueba> => {
    const email = `${etiqueta}.${sufijo}@prueba.cl`;
    const { id } = await uno<{ id: string }>(
      'INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [cliente, email, etiqueta, hash],
    );
    let totpSecreto: string | null = null;
    if (conMfa) {
      totpSecreto = generarSecretoTotp();
      await owner.query('UPDATE usuarios SET totp_secreto_cifrado = $2, totp_activo = true WHERE id = $1', [
        id,
        cifrador.cifrar(totpSecreto, `totp:${id}`),
      ]);
    }
    return { id, email, totpSecreto };
  };

  const usuarios = {
    adminA: await usuario(clienteA, 'admin-a'),
    contadorA1: await usuario(clienteA, 'contador-a1'),
    gerenteA1: await usuario(clienteA, 'gerente-a1'),
    colaboradorA1: await usuario(clienteA, 'colaborador-a1'),
    nuevoSinMfa: await usuario(clienteA, 'nuevo-a', false),
    adminB: await usuario(clienteB, 'admin-b'),
  };

  await owner.query(`INSERT INTO membresias_cliente_erp (usuario_id, cliente_erp_id, rol_codigo) VALUES ($1, $2, 'ADMIN_CLIENTE_ERP')`, [usuarios.adminA.id, clienteA]);
  await owner.query(`INSERT INTO membresias_cliente_erp (usuario_id, cliente_erp_id, rol_codigo) VALUES ($1, $2, 'ADMIN_CLIENTE_ERP')`, [usuarios.adminB.id, clienteB]);
  const membresia = (u: string, e: string, rol: string) =>
    owner.query('INSERT INTO membresias_empresa (usuario_id, empresa_id, rol_codigo) VALUES ($1, $2, $3)', [u, e, rol]);
  await membresia(usuarios.contadorA1.id, empresaA1, 'CONTADOR');
  await membresia(usuarios.contadorA1.id, empresaA2, 'CONTADOR');
  await membresia(usuarios.gerenteA1.id, empresaA1, 'GERENTE_GENERAL');
  await membresia(usuarios.colaboradorA1.id, empresaA1, 'COLABORADOR');
  await membresia(usuarios.nuevoSinMfa.id, empresaA1, 'CONTADOR');

  // Plan de cuentas mínimo en A1 y B1.
  for (const e of [empresaA1, empresaB1]) {
    await owner.query(
      `INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable) VALUES
         ($1, '1', 'Activo', 'ACTIVO', 'DEUDORA', false),
         ($1, '1.1', 'Activo corriente', 'ACTIVO', 'DEUDORA', false),
         ($1, '1.1.01', 'Caja', 'ACTIVO', 'DEUDORA', true),
         ($1, '1.1.02', 'Banco Estado cuenta corriente', 'ACTIVO', 'DEUDORA', true)`,
      [e],
    );
    await owner.query(
      `UPDATE plan_cuentas h SET padre_id = p.id FROM plan_cuentas p
       WHERE h.empresa_id = $1 AND p.empresa_id = $1
         AND ((h.codigo = '1.1' AND p.codigo = '1') OR (h.codigo IN ('1.1.01', '1.1.02') AND p.codigo = '1.1'))`,
      [e],
    );
  }

  return {
    owner,
    db,
    dbAuth,
    cifrador,
    clienteA,
    clienteB,
    empresaA0,
    empresaA1,
    empresaA2,
    empresaB1,
    usuarios,
    cerrar: async () => {
      await db.destroy();
      await dbAuth.destroy();
      await owner.end();
    },
  };
}
