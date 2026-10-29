import { RegistroAgentes } from './agentes/catalogo.js';
import { crearServidor } from './api/servidor.js';
import { cargarConfiguracion } from './config.js';
import { crearDb } from './db/conexion.js';
import { ServicioAutenticacion } from './seguridad/autenticacion.js';
import { Cifrador } from './seguridad/cifrado.js';

async function main(): Promise<void> {
  const config = cargarConfiguracion();
  const db = crearDb(config.DATABASE_URL);
  const dbAuth = crearDb(config.DATABASE_URL_AUTH, 5);
  const autenticacion = new ServicioAutenticacion(dbAuth, new Cifrador(config.CLAVE_MAESTRA_CIFRADO), config);
  const app = await crearServidor({ db, config, autenticacion, registro: new RegistroAgentes() });

  const cerrar = async (senal: string) => {
    app.log.info(`Recibida ${senal}; cerrando.`);
    await app.close();
    await db.destroy();
    await dbAuth.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cerrar('SIGTERM'));
  process.on('SIGINT', () => void cerrar('SIGINT'));

  await app.listen({ port: config.PUERTO, host: '0.0.0.0' });
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
