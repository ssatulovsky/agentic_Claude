import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { evaluarContrasena, hashearContrasena } from '../seguridad/contrasenas.js';
import { normalizarRut, rutEsValido } from '../utilidades/rut.js';

/**
 * Alta de un Cliente ERP nuevo con su empresa propia y su administrador.
 * Es una operación de plataforma: usa la conexión de administración
 * (DATABASE_URL_MIGRACIONES) y queda registrada en la bitácora.
 *
 * Uso:
 *   npm run cli:crear-cliente-erp -- --rut 76.123.456-0 --razon-social "Estudio Contable SpA" \
 *       --admin-email admin@estudio.cl --admin-nombre "Nombre Apellido"
 * La contraseña temporal se toma de CONTRASENA_ADMIN o se genera y se muestra una sola vez.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rut: { type: 'string' },
      'razon-social': { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-nombre': { type: 'string' },
    },
  });
  const rut = normalizarRut(values.rut ?? '');
  const razonSocial = values['razon-social']?.trim();
  const email = values['admin-email']?.trim().toLowerCase();
  const nombre = values['admin-nombre']?.trim();
  if (!rutEsValido(rut) || !razonSocial || !email || !nombre) {
    throw new Error('Faltan datos o el RUT es inválido. Revise --rut, --razon-social, --admin-email y --admin-nombre.');
  }
  const url = process.env.DATABASE_URL_MIGRACIONES;
  if (!url) throw new Error('Falta DATABASE_URL_MIGRACIONES.');

  const generada = !process.env.CONTRASENA_ADMIN;
  const contrasena = process.env.CONTRASENA_ADMIN ?? `${randomBytes(12).toString('base64url')}-Aa1`;
  const politica = evaluarContrasena(contrasena, email);
  if (!politica.valida) throw new Error(`Contraseña inválida: ${politica.motivos.join('; ')}`);
  const hash = await hashearContrasena(contrasena);

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [clienteErp] } = await cliente.query<{ id: string }>(
      'INSERT INTO clientes_erp (rut, razon_social) VALUES ($1, $2) RETURNING id',
      [rut, razonSocial],
    );
    const { rows: [empresa] } = await cliente.query<{ id: string }>(
      `INSERT INTO empresas (cliente_erp_id, rut, razon_social, tipo) VALUES ($1, $2, $3, 'PROPIA') RETURNING id`,
      [clienteErp!.id, rut, razonSocial],
    );
    const { rows: [usuario] } = await cliente.query<{ id: string }>(
      'INSERT INTO usuarios (cliente_erp_id, email, nombre, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [clienteErp!.id, email, nombre, hash],
    );
    await cliente.query(
      `INSERT INTO membresias_cliente_erp (usuario_id, cliente_erp_id, rol_codigo) VALUES ($1, $2, 'ADMIN_CLIENTE_ERP')`,
      [usuario!.id, clienteErp!.id],
    );
    await cliente.query(
      `SELECT bitacora_registrar('SISTEMA', 'cli-crear-cliente-erp', 'cliente_erp.creado', 'clientes_erp', $1, $2::jsonb, $3::uuid)`,
      [clienteErp!.id, JSON.stringify({ rut, razon_social: razonSocial, admin: email }), empresa!.id],
    );
    await cliente.query('COMMIT');
    console.log(`Cliente ERP creado: ${razonSocial} (${rut})`);
    console.log(`Empresa propia: ${empresa!.id}`);
    console.log(`Administrador: ${email}`);
    if (generada) {
      console.log(`Contraseña temporal (se muestra una sola vez): ${contrasena}`);
    }
    console.log('Al primer ingreso deberá configurar el doble factor.');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    await cliente.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
