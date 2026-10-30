import pg from 'pg';
import { FuenteCmf, FuenteMindicador, sincronizarIndicadores, type FuenteIndicadores } from '../normativa/indicadores.js';

/**
 * Sincronización diaria de UF, UTM y dólar observado (operación de plataforma).
 * Programarla una vez al día en el servidor, por ejemplo con cron a las 08:15:
 *   15 8 * * *  cd /opt/erp && npm run -s cli:sincronizar-indicadores >> /var/log/erp/indicadores.log 2>&1
 *
 * Fuentes: mindicador.cl siempre; además la CMF si se define CMF_API_KEY (con dos
 * fuentes, un valor solo se guarda si ambas coinciden).
 * Código de salida 2 si hubo discrepancias, conflictos, valores sin confirmar o rechazados, para
 * que el monitoreo avise a una persona.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) throw new Error('Falta DATABASE_URL_MIGRACIONES.');
  const fuentes: FuenteIndicadores[] = [new FuenteMindicador()];
  if (process.env.CMF_API_KEY) fuentes.push(new FuenteCmf(process.env.CMF_API_KEY));

  const anioActual = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric' }).format(new Date()));
  // La UF se publica con anticipación: en diciembre ya hay valores de enero.
  const anios = [anioActual, anioActual + 1];

  const cliente = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await cliente.connect();
  try {
    const tipos = ['UF', 'UTM', 'DOLAR'] as const;
    const r = await sincronizarIndicadores(cliente, fuentes, anios, [...tipos]);
    console.log(JSON.stringify({ fecha: new Date().toISOString(), ...r }, null, 2));
    if (r.discrepancias.length || r.conflictos.length || r.rechazados.length || r.sinConfirmar.length) process.exitCode = 2;
    if (r.erroresFuente.length === fuentes.length * anios.length * 3) process.exitCode = 1;
  } finally {
    await cliente.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
