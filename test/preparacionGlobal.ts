import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrar } from '../src/db/migrar.js';

/**
 * Crea una base de datos de prueba nueva, con los mismos roles que producción,
 * aplica todas las migraciones y la elimina al terminar.
 *
 * Requiere un PostgreSQL 16+ accesible con un superusuario en TEST_PG_ADMIN_URL
 * (por defecto postgres://postgres@localhost:5432/postgres).
 */
export const CLAVE_PRUEBAS = 'a'.repeat(64);

function conBase(url: string, base: string, usuario?: string, clave?: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  if (usuario) u.username = usuario;
  if (clave !== undefined) u.password = clave;
  return u.toString();
}

export async function crearBaseDePrueba(
  adminUrl: string,
  nombre: string,
): Promise<{ owner: string; app: string; auth: string }> {
  const claveOwner = process.env.TEST_PG_OWNER_PASS ?? 'owner_pruebas';
  const claveApp = process.env.TEST_PG_APP_PASS ?? 'app_pruebas';
  const claveAuth = process.env.TEST_PG_AUTH_PASS ?? 'auth_pruebas';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const roles = await admin.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('erp_owner', 'erp_app', 'erp_auth')`,
    );
    const existentes = new Set(roles.rows.map((r) => r.rolname));
    if (!existentes.has('erp_owner')) {
      await admin.query(`CREATE ROLE erp_owner LOGIN PASSWORD '${claveOwner}'`);
    }
    if (!existentes.has('erp_app')) {
      await admin.query(`CREATE ROLE erp_app LOGIN NOBYPASSRLS PASSWORD '${claveApp}'`);
    }
    if (!existentes.has('erp_auth')) {
      await admin.query(`CREATE ROLE erp_auth LOGIN NOBYPASSRLS PASSWORD '${claveAuth}'`);
    }
    await admin.query(`CREATE DATABASE ${nombre} OWNER erp_owner ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  const enBase = new pg.Client({ connectionString: conBase(adminUrl, nombre) });
  await enBase.connect();
  await enBase.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO erp_owner; GRANT USAGE ON SCHEMA public TO erp_app, erp_auth;');
  await enBase.end();

  const owner = conBase(adminUrl, nombre, 'erp_owner', claveOwner);
  await migrar(owner);
  return {
    owner,
    app: conBase(adminUrl, nombre, 'erp_app', claveApp),
    auth: conBase(adminUrl, nombre, 'erp_auth', claveAuth),
  };
}

export async function eliminarBaseDePrueba(adminUrl: string, nombre: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
  await admin.end();
}

export default async function preparar(proyecto: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
  const nombre = `erp_prueba_${randomBytes(4).toString('hex')}`;
  const urls = await crearBaseDePrueba(adminUrl, nombre);
  proyecto.provide('urlOwner', urls.owner);
  proyecto.provide('urlApp', urls.app);
  proyecto.provide('urlAuth', urls.auth);
  proyecto.provide('urlAdmin', adminUrl);
  return async () => {
    await eliminarBaseDePrueba(adminUrl, nombre);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    urlOwner: string;
    urlApp: string;
    urlAuth: string;
    urlAdmin: string;
  }
}
