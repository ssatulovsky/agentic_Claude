import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Configuracion } from '../config.js';
import { contextoDeUsuario, enContexto, sinContexto, type Db, type Trx } from '../db/conexion.js';
import { ErrorNegocio } from '../errores.js';
import type { Cifrador } from './cifrado.js';
import { obtenerHashFicticio, verificarContrasena } from './contrasenas.js';
import { generarSecretoTotp, urlOtpAuth, verificarTotp } from './totp.js';

export interface SesionResuelta {
  sesionId: string;
  usuarioId: string;
  clienteErpId: string;
  mfaVerificada: boolean;
  totpActivo: boolean;
}

export interface ResultadoLogin {
  token: string;
  /** El usuario debe enrolar el doble factor antes de acceder a datos. */
  requiereEnrolarMfa: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();
const contextoTotp = (usuarioId: string) => `totp:${usuarioId}`;

/** Un único mensaje para todo fallo de ingreso: no revela si el correo existe ni si la cuenta está bloqueada. */
const ingresoFallido = () =>
  new ErrorNegocio(
    'CREDENCIALES_INVALIDAS',
    'No fue posible ingresar. Revise su correo y contraseña; tras varios intentos fallidos la cuenta se bloquea 15 minutos.',
    401,
  );
const cuentaBloqueada = () =>
  new ErrorNegocio('CUENTA_BLOQUEADA', 'Demasiados intentos fallidos. La cuenta quedó bloqueada 15 minutos.', 423);

async function registrarEvento(
  trx: Trx,
  accion: string,
  datos: Record<string, unknown>,
  entidadId: string | null = null,
): Promise<void> {
  await sql`SELECT bitacora_registrar('SISTEMA', 'autenticacion', ${accion}, 'usuarios', ${entidadId}, ${JSON.stringify(datos)}::jsonb)`.execute(
    trx,
  );
}

/**
 * Servicio de autenticación. Usa su PROPIA conexión con el rol erp_auth, el
 * único que puede ejecutar las funciones de contraseñas y sesiones.
 */
export class ServicioAutenticacion {
  constructor(
    private readonly dbAuth: Db,
    private readonly cifrador: Cifrador,
    private readonly config: Pick<Configuracion, 'SESION_DURACION_HORAS' | 'SESION_INACTIVIDAD_MINUTOS' | 'MFA_EMISOR'>,
  ) {}

  /** Reserva un intento antes de verificar nada. false = cuenta bloqueada (o inexistente). */
  private async reservarIntento(usuarioId: string): Promise<boolean> {
    return sinContexto(this.dbAuth, async (trx) => {
      const { rows } = await sql<{ ok: boolean }>`SELECT auth_reservar_intento(${usuarioId}::uuid) AS ok`.execute(trx);
      return rows[0]?.ok === true;
    });
  }

  /**
   * Primer paso del ingreso: correo y contraseña. Deja una sesión SIN doble factor
   * verificado; los datos solo se abren tras el segundo paso.
   */
  async iniciarSesion(email: string, contrasena: string, ip: string | null, userAgent: string | null): Promise<ResultadoLogin> {
    const credenciales = await sinContexto(this.dbAuth, async (trx) => {
      const { rows } = await sql<{ usuario_id: string; password_hash: string; totp_activo: boolean; estado: string }>`
        SELECT usuario_id, password_hash, totp_activo, estado FROM auth_credenciales(${email})`.execute(trx);
      return rows[0];
    });

    if (!credenciales) {
      // Mismo costo de cómputo que un usuario real, para no revelar qué correos existen.
      await verificarContrasena(await obtenerHashFicticio(), contrasena);
      await sinContexto(this.dbAuth, (trx) => registrarEvento(trx, 'login.fallido', { motivo: 'correo_desconocido' }));
      throw ingresoFallido();
    }

    const usuarioId = credenciales.usuario_id;
    const ctx = contextoDeUsuario(usuarioId);
    if (!(await this.reservarIntento(usuarioId))) {
      await verificarContrasena(await obtenerHashFicticio(), contrasena);
      await enContexto(this.dbAuth, ctx, (trx) => registrarEvento(trx, 'login.rechazado', { motivo: 'cuenta_bloqueada' }, usuarioId));
      throw ingresoFallido();
    }

    const contrasenaOk = await verificarContrasena(credenciales.password_hash, contrasena);
    if (!contrasenaOk || credenciales.estado !== 'ACTIVO') {
      // El intento ya quedó contado al reservarlo.
      await enContexto(this.dbAuth, ctx, (trx) =>
        registrarEvento(trx, 'login.fallido', { motivo: contrasenaOk ? 'usuario_inactivo' : 'contrasena_incorrecta' }, usuarioId),
      );
      throw ingresoFallido();
    }

    const token = randomBytes(32).toString('base64url');
    const expira = new Date(Date.now() + this.config.SESION_DURACION_HORAS * 3600_000);
    await enContexto(this.dbAuth, ctx, async (trx) => {
      // Una contraseña correcta no cuenta como fallo, pero el contador solo vuelve
      // a cero tras el doble factor: conocer la contraseña no da intentos ilimitados.
      await sql`SELECT auth_liberar_intento(${usuarioId}::uuid)`.execute(trx);
      await sql`SELECT auth_crear_sesion(${usuarioId}::uuid, ${hashToken(token)}, ${expira}, ${ip}::inet, ${userAgent})`.execute(trx);
      await registrarEvento(trx, 'login.contrasena_ok', { requiere_mfa: true }, usuarioId);
    });
    return { token, requiereEnrolarMfa: !credenciales.totp_activo };
  }

  async resolverSesion(token: string | undefined): Promise<SesionResuelta | null> {
    if (!token || token.length > 100) return null;
    return sinContexto(this.dbAuth, async (trx) => {
      const { rows } = await sql<{
        sesion_id: string;
        usuario_id: string;
        cliente_erp_id: string;
        mfa_verificada: boolean;
        totp_activo: boolean;
      }>`SELECT * FROM auth_resolver_sesion(${hashToken(token)}, ${`${this.config.SESION_INACTIVIDAD_MINUTOS} minutes`}::interval)`.execute(
        trx,
      );
      const fila = rows[0];
      return fila
        ? {
            sesionId: fila.sesion_id,
            usuarioId: fila.usuario_id,
            clienteErpId: fila.cliente_erp_id,
            mfaVerificada: fila.mfa_verificada,
            totpActivo: fila.totp_activo,
          }
        : null;
    });
  }

  /** Genera una semilla nueva para enrolar el doble factor (solo si aún no está activo). */
  async iniciarEnrolamientoMfa(sesion: SesionResuelta, email: string): Promise<{ secreto: string; urlOtpAuth: string }> {
    if (sesion.totpActivo) {
      throw new ErrorNegocio('MFA_YA_ACTIVO', 'El doble factor ya está activo para esta cuenta.', 409);
    }
    const secreto = generarSecretoTotp();
    const cifrado = this.cifrador.cifrar(secreto, contextoTotp(sesion.usuarioId));
    await enContexto(this.dbAuth, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await sql`SELECT auth_guardar_totp_pendiente(${sesion.usuarioId}::uuid, ${cifrado})`.execute(trx);
      await registrarEvento(trx, 'mfa.enrolamiento_iniciado', {}, sesion.usuarioId);
    });
    return { secreto, urlOtpAuth: urlOtpAuth(this.config.MFA_EMISOR, email, secreto) };
  }

  /** Confirma el enrolamiento con un primer código válido y deja la sesión verificada. */
  async activarMfa(sesion: SesionResuelta, codigo: string): Promise<void> {
    if (sesion.totpActivo) {
      throw new ErrorNegocio('MFA_YA_ACTIVO', 'El doble factor ya está activo para esta cuenta.', 409);
    }
    const cifradoVerificado = await this.validarCodigo(sesion, codigo, 'mfa.activacion_fallida');
    await enContexto(this.dbAuth, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      // Se activa solo si el secreto pendiente es exactamente el que se verificó.
      const { rows } = await sql<{ ok: boolean }>`
        SELECT auth_activar_totp(${sesion.usuarioId}::uuid, ${cifradoVerificado}) AS ok`.execute(trx);
      if (rows[0]?.ok !== true) {
        throw new ErrorNegocio('MFA_CAMBIADO', 'El enrolamiento cambió mientras se verificaba. Vuelva a empezar.', 409);
      }
      await sql`SELECT auth_marcar_mfa(${sesion.sesionId}::uuid)`.execute(trx);
      await sql`SELECT auth_ingreso_completo(${sesion.usuarioId}::uuid)`.execute(trx);
      await registrarEvento(trx, 'mfa.activado', {}, sesion.usuarioId);
    });
  }

  /** Segundo paso del ingreso para usuarios con doble factor activo. */
  async verificarMfa(sesion: SesionResuelta, codigo: string): Promise<void> {
    if (!sesion.totpActivo) {
      throw new ErrorNegocio('MFA_NO_ENROLADO', 'Primero debe enrolar el doble factor.', 409);
    }
    await this.validarCodigo(sesion, codigo, 'login.mfa_fallido');
    await enContexto(this.dbAuth, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await sql`SELECT auth_marcar_mfa(${sesion.sesionId}::uuid)`.execute(trx);
      await sql`SELECT auth_ingreso_completo(${sesion.usuarioId}::uuid)`.execute(trx);
      await registrarEvento(trx, 'login.mfa_ok', {}, sesion.usuarioId);
    });
  }

  async cerrarSesion(sesion: SesionResuelta): Promise<void> {
    await enContexto(this.dbAuth, contextoDeUsuario(sesion.usuarioId), async (trx) => {
      await sql`SELECT auth_revocar_sesion(${sesion.sesionId}::uuid)`.execute(trx);
      await registrarEvento(trx, 'logout', {}, sesion.usuarioId);
    });
  }

  /** Verifica un código. Devuelve el secreto cifrado contra el que se validó. */
  private async validarCodigo(sesion: SesionResuelta, codigo: string, accionFallo: string): Promise<string> {
    const ctx = contextoDeUsuario(sesion.usuarioId);
    // El intento se reserva ANTES de verificar: en paralelo, solo 5 llegan a verificarse.
    if (!(await this.reservarIntento(sesion.usuarioId))) {
      await enContexto(this.dbAuth, ctx, (trx) => registrarEvento(trx, accionFallo, { motivo: 'cuenta_bloqueada' }, sesion.usuarioId));
      throw cuentaBloqueada();
    }
    const cifradoValido = await enContexto(this.dbAuth, ctx, async (trx) => {
      const { rows } = await sql<{ totp_secreto_cifrado: string | null }>`
        SELECT totp_secreto_cifrado FROM auth_obtener_totp(${sesion.usuarioId}::uuid)`.execute(trx);
      const cifrado = rows[0]?.totp_secreto_cifrado;
      if (!cifrado) return null;
      const paso = verificarTotp(this.cifrador.descifrar(cifrado, contextoTotp(sesion.usuarioId)), codigo);
      if (paso === null) return null;
      // Un mismo código no se acepta dos veces.
      const consumo = await sql<{ ok: boolean }>`SELECT auth_consumir_paso_totp(${sesion.usuarioId}::uuid, ${paso}) AS ok`.execute(trx);
      return consumo.rows[0]?.ok === true ? cifrado : null;
    });
    if (!cifradoValido) {
      await enContexto(this.dbAuth, ctx, (trx) => registrarEvento(trx, accionFallo, {}, sesion.usuarioId));
      throw new ErrorNegocio('CODIGO_INVALIDO', 'El código de verificación no es válido.', 401);
    }
    return cifradoValido;
  }
}
