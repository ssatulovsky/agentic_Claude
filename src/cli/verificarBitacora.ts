import pg from 'pg';

/**
 * Verificación de integridad de la bitácora completa (operación de plataforma).
 * Recorre la cadena de todos los clientes, por eso no se expone en la API.
 * Imprime el hash de la cabeza para anclarlo fuera de la base de datos
 * (por ejemplo, en un correo firmado diario o en almacenamiento inmutable).
 *
 * Uso: npm run cli:verificar-bitacora
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) throw new Error('Falta DATABASE_URL_MIGRACIONES.');
  const cliente = new pg.Client({ connectionString: url, options: '-c statement_timeout=0' });
  await cliente.connect();
  try {
    const { rows } = await cliente.query<{ alterado: string | null }>('SELECT bitacora_verificar() AS alterado');
    const { rows: cabeza } = await cliente.query<{ ultimo_id: string | null; ultimo_hash: string }>(
      `SELECT ultimo_id, encode(ultimo_hash, 'hex') AS ultimo_hash FROM bitacora_cabeza`,
    );
    const fecha = new Date().toISOString();
    if (rows[0]?.alterado) {
      console.error(`[${fecha}] BITÁCORA ALTERADA. Primer problema en el evento ${rows[0].alterado}.`);
      process.exitCode = 2;
      return;
    }
    console.log(`[${fecha}] Bitácora íntegra. Último evento: ${cabeza[0]?.ultimo_id ?? 'ninguno'}`);
    console.log(`Hash de la cabeza (anclar externamente): ${cabeza[0]?.ultimo_hash}`);
  } finally {
    await cliente.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
