import pg from 'pg';

/**
 * Administración de la capa de IA (operación de plataforma, rol erp_owner):
 *
 *   npm run cli:ia -- precio <modelo> <desde AAAA-MM-DD> <usd_entrada_por_millon> <usd_salida_por_millon> <fuente> <url_fuente>
 *        [<umbral_tokens_entrada> <usd_entrada_sobre_umbral> <usd_salida_sobre_umbral>]
 *   npm run cli:ia -- cupo <rut_cliente_erp> <desde AAAA-MM-01> <usd_mensual> <CONTINUAR|SOLO_LOCAL>
 *   npm run cli:ia -- modelo <codigo> <ANTHROPIC|GEMINI|OLLAMA> <nombre_api> <descripcion>
 *
 * Los precios se cargan desde la página oficial de cada proveedor, con su URL. Un precio
 * nuevo cierra el anterior el día en que empieza.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) throw new Error('Falta DATABASE_URL_MIGRACIONES.');
  const [accion, ...a] = process.argv.slice(2);
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query('BEGIN');
    if (accion === 'precio' && (a.length === 6 || a.length === 9)) {
      const [modelo, desde, entrada, salida, fuente, urlFuente] = a as [string, string, string, string, string, string];
      const [umbral = null, entradaSobre = null, salidaSobre = null] = a.slice(6);
      await cliente.query(
        `UPDATE precios_modelos_ia SET vigente_hasta = $2 WHERE modelo = $1 AND vigente_hasta IS NULL AND vigente_desde < $2`,
        [modelo, desde],
      );
      await cliente.query(
        `INSERT INTO precios_modelos_ia (modelo, vigente_desde, usd_por_millon_entrada, usd_por_millon_salida, fuente, url_fuente,
           umbral_tokens_entrada, usd_por_millon_entrada_sobre_umbral, usd_por_millon_salida_sobre_umbral)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [modelo, desde, entrada, salida, fuente, urlFuente, umbral, entradaSobre, salidaSobre],
      );
    } else if (accion === 'cupo' && a.length === 4) {
      const [rut, desde, usd, alExceder] = a as [string, string, string, string];
      const r = await cliente.query(
        `INSERT INTO cupos_ia (cliente_erp_id, vigente_desde, usd_mensual, al_exceder)
         SELECT id, $2, $3, $4 FROM clientes_erp WHERE rut = $1 RETURNING id`,
        [rut, desde, usd, alExceder],
      );
      if (r.rowCount === 0) throw new Error(`No existe el Cliente ERP ${rut}`);
    } else if (accion === 'modelo' && a.length === 4) {
      const [codigo, proveedor, nombreApi, descripcion] = a as [string, string, string, string];
      await cliente.query(
        `INSERT INTO modelos_ia (codigo, proveedor, nombre_api, local, descripcion) VALUES ($1, $2, $3, $2 = 'OLLAMA', $4)`,
        [codigo, proveedor, nombreApi, descripcion],
      );
    } else {
      throw new Error('Uso: precio|cupo|modelo (ver el encabezado de src/cli/iaPlataforma.ts)');
    }
    await cliente.query(
      `SELECT bitacora_registrar('SISTEMA', 'cli-ia', $1, 'capa_ia', NULL, $2::jsonb, NULL, NULL)`,
      [`ia.${accion}`, JSON.stringify(a)],
    );
    await cliente.query('COMMIT');
    console.log('Listo.');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    await cliente.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
