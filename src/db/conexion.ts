import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { BaseDatos } from './tipos.js';

// Las columnas numeric se devuelven como texto para no perder precisión.
// La conversión a número se hace explícitamente donde corresponde.
pg.types.setTypeParser(pg.types.builtins.DATE, (valor: string) => valor);

export type Db = Kysely<BaseDatos>;
export type Trx = Transaction<BaseDatos>;

export function crearDb(urlConexion: string, maxConexiones = 10): Db {
  return new Kysely<BaseDatos>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: urlConexion,
        max: maxConexiones,
        // Cada conexión trabaja en UTC; las fechas legales son 'date' sin zona.
        options: '-c TimeZone=UTC -c statement_timeout=15000',
      }),
    }),
  });
}

export type TipoActor = 'USUARIO' | 'AGENTE' | 'SISTEMA';

/**
 * Identidad con la que se ejecuta una transacción. La base de datos la usa para
 * aplicar la seguridad por fila y para registrar la bitácora.
 */
export interface ContextoSeguridad {
  usuarioId: string;
  /** Empresa en la que se trabaja. Sin empresa solo se ven datos del Cliente ERP. */
  empresaId: string | null;
  actorTipo: TipoActor;
  /** Para un agente, su código (p. ej. CONTADOR_GENERAL); para un usuario, su id. */
  actorId: string;
}

export function contextoDeUsuario(usuarioId: string, empresaId: string | null = null): ContextoSeguridad {
  return { usuarioId, empresaId, actorTipo: 'USUARIO', actorId: usuarioId };
}

/**
 * Ejecuta una función dentro de una transacción con el contexto de seguridad
 * declarado. Las variables se fijan con alcance de transacción (set_config local),
 * así que no se filtran a otra petición que reutilice la conexión.
 */
export async function enContexto<T>(db: Db, contexto: ContextoSeguridad, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`
      SELECT set_config('app.usuario_id', ${contexto.usuarioId}, true),
             set_config('app.empresa_id', ${contexto.empresaId ?? ''}, true),
             set_config('app.actor_tipo', ${contexto.actorTipo}, true),
             set_config('app.actor_id', ${contexto.actorId}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** Transacción sin usuario: solo para funciones de autenticación y lectura de catálogos públicos. */
export async function sinContexto<T>(db: Db, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}
