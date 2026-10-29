import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CARPETA_MIGRACIONES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migraciones');

export interface ResultadoMigracion {
  aplicadas: string[];
  yaAplicadas: string[];
}

/**
 * Aplica en orden las migraciones SQL pendientes, cada una en su propia transacción.
 * Si un archivo ya aplicado fue modificado, se detiene: una migración aplicada no se edita,
 * se corrige con una migración nueva.
 */
export async function migrar(urlConexion: string, carpeta = CARPETA_MIGRACIONES): Promise<ResultadoMigracion> {
  const cliente = new pg.Client({ connectionString: urlConexion });
  await cliente.connect();
  try {
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
        nombre      text PRIMARY KEY,
        checksum    text NOT NULL,
        aplicada_en timestamptz NOT NULL DEFAULT now()
      )`);
    await cliente.query('SELECT pg_advisory_lock(hashtext($1))', ['migraciones_erp']);

    const archivos = (await readdir(carpeta)).filter((a) => /^\d{4}_.+\.sql$/.test(a)).sort();
    const { rows } = await cliente.query<{ nombre: string; checksum: string }>(
      'SELECT nombre, checksum FROM migraciones_aplicadas',
    );
    const aplicadas = new Map(rows.map((r) => [r.nombre, r.checksum]));
    const resultado: ResultadoMigracion = { aplicadas: [], yaAplicadas: [] };

    for (const archivo of archivos) {
      const sql = await readFile(path.join(carpeta, archivo), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previo = aplicadas.get(archivo);
      if (previo) {
        if (previo !== checksum) {
          throw new Error(
            `La migración ${archivo} fue modificada después de aplicarse. Cree una migración nueva en su lugar.`,
          );
        }
        resultado.yaAplicadas.push(archivo);
        continue;
      }
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migraciones_aplicadas (nombre, checksum) VALUES ($1, $2)', [archivo, checksum]);
        await cliente.query('COMMIT');
        resultado.aplicadas.push(archivo);
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${(error as Error).message}`, { cause: error });
      }
    }
    return resultado;
  } finally {
    await cliente.query('SELECT pg_advisory_unlock(hashtext($1))', ['migraciones_erp']).catch(() => undefined);
    await cliente.end();
  }
}

// Uso directo: npm run db:migrar
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) {
    console.error('Falta DATABASE_URL_MIGRACIONES (conexión con el rol erp_owner).');
    process.exit(1);
  }
  migrar(url)
    .then((r) => {
      console.log(`Migraciones aplicadas: ${r.aplicadas.length ? r.aplicadas.join(', ') : 'ninguna'}`);
      console.log(`Ya estaban aplicadas: ${r.yaAplicadas.length}`);
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
