import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RegistroAgentes } from '../src/agentes/catalogo.js';
import { crearServidor, NOMBRE_COOKIE } from '../src/api/servidor.js';
import { cargarConfiguracion } from '../src/config.js';
import { ServicioAutenticacion } from '../src/seguridad/autenticacion.js';
import { base32Decodificar, codigoParaPaso, pasoTotp } from '../src/seguridad/totp.js';
import { CLAVE_PRUEBAS } from './preparacionGlobal.js';
import { CONTRASENA, crearEscenario, rutAleatorio, type Escenario, type UsuarioPrueba } from './escenario.js';

let e: Escenario;
let app: FastifyInstance;

beforeAll(async () => {
  e = await crearEscenario();
  const config = cargarConfiguracion({
    NODE_ENV: 'test',
    DATABASE_URL: inject('urlApp'),
    DATABASE_URL_AUTH: inject('urlAuth'),
    CLAVE_MAESTRA_CIFRADO: CLAVE_PRUEBAS,
    LIMITE_LOGIN_POR_MINUTO: '1000',
  });
  app = await crearServidor({
    db: e.db,
    config,
    autenticacion: new ServicioAutenticacion(e.dbAuth, e.cifrador, config),
    registro: new RegistroAgentes(),
  });
});
afterAll(async () => {
  await app.close();
  await e.cerrar();
});

const cookieDe = (r: LightMyRequestResponse) => r.cookies.find((c) => c.name === NOMBRE_COOKIE)?.value;

async function ingresar(u: UsuarioPrueba): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
  expect(login.statusCode).toBe(200);
  const cookie = cookieDe(login)!;
  const mfa = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verificar',
    cookies: { [NOMBRE_COOKIE]: cookie },
    payload: { codigo: codigoParaPaso(base32Decodificar(u.totpSecreto!), pasoTotp(Date.now())) },
  });
  expect(mfa.statusCode).toBe(200);
  return cookie;
}

describe('Ingreso con doble factor obligatorio', () => {
  it('rechaza una contraseña incorrecta sin revelar si el correo existe', async () => {
    const malaClave = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: e.usuarios.gerenteA1.email, contrasena: 'incorrecta' },
    });
    const sinCuenta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nadie@ninguna.cl', contrasena: 'incorrecta' },
    });
    expect(malaClave.statusCode).toBe(401);
    expect(sinCuenta.statusCode).toBe(401);
    expect(malaClave.json().error.mensaje).toBe(sinCuenta.json().error.mensaje);
  });

  it('con la contraseña correcta todavía no se accede a datos sin el segundo factor', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: e.usuarios.contadorA1.email, contrasena: CONTRASENA },
    });
    expect(login.json()).toEqual({ siguientePaso: 'VERIFICAR_MFA' });
    const cookie = login.cookies.find((c) => c.name === NOMBRE_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    const yo = await app.inject({ method: 'GET', url: '/api/yo', cookies: { [NOMBRE_COOKIE]: cookie.value } });
    expect(yo.statusCode).toBe(401);
    expect(yo.json().error.codigo).toBe('MFA_REQUERIDA');
  });

  it('un usuario nuevo debe enrolar el doble factor y luego accede', async () => {
    const u = e.usuarios.nuevoSinMfa;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
    expect(login.json()).toEqual({ siguientePaso: 'ENROLAR_MFA' });
    const cookie = cookieDe(login)!;

    const enrolar = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/enrolar',
      cookies: { [NOMBRE_COOKIE]: cookie },
      headers: { 'x-erp-solicitud': '1' },
    });
    expect(enrolar.statusCode).toBe(200);
    const { secreto, urlOtpAuth } = enrolar.json() as { secreto: string; urlOtpAuth: string };
    expect(urlOtpAuth).toMatch(/^otpauth:\/\/totp\//u);

    const codigo = codigoParaPaso(base32Decodificar(secreto), pasoTotp(Date.now()));
    const activar = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/activar',
      cookies: { [NOMBRE_COOKIE]: cookie },
      payload: { codigo },
    });
    expect(activar.statusCode).toBe(200);

    const yo = await app.inject({ method: 'GET', url: '/api/yo', cookies: { [NOMBRE_COOKIE]: cookie } });
    expect(yo.statusCode).toBe(200);
    expect(yo.json().empresas.map((x: { id: string }) => x.id)).toEqual([e.empresaA1]);

    // El mismo código no sirve dos veces (protección contra repetición).
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
    const repetido = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verificar',
      cookies: { [NOMBRE_COOKIE]: cookieDe(login2)! },
      payload: { codigo },
    });
    expect(repetido.statusCode).toBe(401);
    expect(repetido.json().error.codigo).toBe('CODIGO_INVALIDO');
  });

  it('bloquea la cuenta tras 5 intentos fallidos', async () => {
    const u = e.usuarios.colaboradorA1;
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: `mala-${i}` } });
    }
    // Bloqueada, ni la contraseña correcta entra; y la respuesta es la misma que para
    // un correo inexistente (no revela que la cuenta existe ni que está bloqueada).
    const bloqueada = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
    const inexistente = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'no@existe.cl', contrasena: 'x' } });
    expect(bloqueada.statusCode).toBe(401);
    expect(bloqueada.json()).toEqual(inexistente.json());
  });

  it('cien códigos en paralelo no permiten más de 5 verificaciones (fuerza bruta del doble factor)', async () => {
    const u = e.usuarios.adminB;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, contrasena: CONTRASENA } });
    const cookie = cookieDe(login)!;
    const respuestas = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/mfa/verificar',
          cookies: { [NOMBRE_COOKIE]: cookie },
          payload: { codigo: String(100000 + i) },
        }),
      ),
    );
    const codigos = respuestas.map((r) => r.json().error?.codigo as string);
    const verificados = codigos.filter((c) => c === 'CODIGO_INVALIDO').length;
    expect(verificados).toBeLessThanOrEqual(5);
    expect(codigos.filter((c) => c === 'CUENTA_BLOQUEADA').length).toBe(100 - verificados);
  });

  it('limita los intentos de ingreso por IP', async () => {
    const config = cargarConfiguracion({
      NODE_ENV: 'test',
      DATABASE_URL: inject('urlApp'),
      DATABASE_URL_AUTH: inject('urlAuth'),
      CLAVE_MAESTRA_CIFRADO: CLAVE_PRUEBAS,
      LIMITE_LOGIN_POR_MINUTO: '2',
    });
    const estricta = await crearServidor({
      db: e.db,
      config,
      autenticacion: new ServicioAutenticacion(e.dbAuth, e.cifrador, config),
      registro: new RegistroAgentes(),
    });
    const intento = () =>
      estricta.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.cl', contrasena: 'z' } });
    expect((await intento()).statusCode).toBe(401);
    expect((await intento()).statusCode).toBe(401);
    const tercero = await intento();
    expect(tercero.statusCode).toBe(429);
    expect(tercero.json().error.codigo).toBe('DEMASIADAS_PETICIONES');
    await estricta.close();
  });

  it('cerrar sesión invalida la cookie en el servidor', async () => {
    const cookie = await ingresar(e.usuarios.gerenteA1);
    expect((await app.inject({ method: 'GET', url: '/api/yo', cookies: { [NOMBRE_COOKIE]: cookie } })).statusCode).toBe(200);
    // Sin la cabecera anti-CSRF, un POST sin cuerpo se rechaza.
    const sinCabecera = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [NOMBRE_COOKIE]: cookie } });
    expect(sinCabecera.statusCode).toBe(415);
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [NOMBRE_COOKIE]: cookie },
      headers: { 'x-erp-solicitud': '1' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/yo', cookies: { [NOMBRE_COOKIE]: cookie } })).statusCode).toBe(401);
  });
});

describe('Datos por empresa a través de la API', () => {
  let cookieContador: string;
  let cookieAdminA: string;
  beforeAll(async () => {
    cookieContador = await ingresar(e.usuarios.contadorA1);
    cookieAdminA = await ingresar(e.usuarios.adminA);
  });

  it('el contador lista y crea cuentas en su empresa', async () => {
    const lista = await app.inject({
      method: 'GET',
      url: `/api/empresas/${e.empresaA1}/plan-cuentas`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
    });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().length).toBeGreaterThanOrEqual(4);

    const crear = await app.inject({
      method: 'POST',
      url: `/api/empresas/${e.empresaA1}/plan-cuentas`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
      payload: {
        codigo: '1.1.03',
        nombre: 'Banco Santander cuenta corriente',
        clasificacion: 'ACTIVO',
        naturaleza: 'DEUDORA',
        imputable: true,
        codigoPadre: '1.1',
      },
    });
    expect(crear.statusCode).toBe(201);
  });

  it('no permite colgar una cuenta de una cuenta imputable', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/empresas/${e.empresaA1}/plan-cuentas`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
      payload: { codigo: '1.1.01.1', nombre: 'Sub caja', clasificacion: 'ACTIVO', naturaleza: 'DEUDORA', imputable: true, codigoPadre: '1.1.01' },
    });
    expect(r.statusCode).toBe(422);
  });

  it('pedir datos de una empresa de otro Cliente ERP devuelve 403', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/empresas/${e.empresaB1}/plan-cuentas`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
    });
    expect(r.statusCode).toBe(403);
  });

  it('un RUT con dígito verificador inválido se rechaza', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/empresas/${e.empresaA1}/terceros`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
      payload: { rut: '11.111.111-2', razonSocial: 'Proveedor X', esProveedor: true },
    });
    expect(r.statusCode).toBe(422);
  });

  it('solo el administrador del Cliente ERP crea empresas ancla y contrata módulos', async () => {
    const porContador = await app.inject({
      method: 'POST',
      url: '/api/empresas',
      cookies: { [NOMBRE_COOKIE]: cookieContador },
      payload: { rut: rutAleatorio(), razonSocial: 'No debería', tipo: 'ANCLA' },
    });
    expect(porContador.statusCode).toBe(403);

    const creada = await app.inject({
      method: 'POST',
      url: '/api/empresas',
      cookies: { [NOMBRE_COOKIE]: cookieAdminA },
      payload: { rut: rutAleatorio(), razonSocial: 'Agrícola Ancla Nueva', tipo: 'ANCLA' },
    });
    expect(creada.statusCode).toBe(201);
    const empresaId = creada.json().id as string;

    const modulo = await app.inject({
      method: 'POST',
      url: `/api/empresas/${empresaId}/suscripciones`,
      cookies: { [NOMBRE_COOKIE]: cookieAdminA },
      payload: { modulo: 'FLUJO_CAJA', pagador: 'EMPRESA', vigenteDesde: '2026-11-01' },
    });
    expect(modulo.statusCode).toBe(201);

    const duplicada = await app.inject({
      method: 'POST',
      url: `/api/empresas/${empresaId}/suscripciones`,
      cookies: { [NOMBRE_COOKIE]: cookieAdminA },
      payload: { modulo: 'FLUJO_CAJA', pagador: 'EMPRESA', vigenteDesde: '2026-12-01' },
    });
    expect(duplicada.statusCode).toBe(409);
  });

  it('consulta un parámetro legal con su fuente', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/empresas/${e.empresaA1}/normativa/parametros/TOPE_IMPONIBLE.SEGURO_CESANTIA?fecha=2026-10-29`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ valor: '135.2', unidad: 'UF' });
  });

  it('rechaza peticiones que modifican datos si no son JSON', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/empresas/${e.empresaA1}/centros-costo`,
      cookies: { [NOMBRE_COOKIE]: cookieContador },
      headers: { 'content-type': 'text/plain' },
      payload: 'codigo=X',
    });
    expect(r.statusCode).toBe(415);
  });

  it('envía cabeceras de seguridad', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/salud' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('libro diario por la API: ejercicio, asiento, balance y mayor', async () => {
    const c = { [NOMBRE_COOKIE]: cookieContador };
    const base = `/api/empresas/${e.empresaA1}`;
    expect((await app.inject({ method: 'POST', url: `${base}/ejercicios`, cookies: c, payload: { anio: 2026 } })).statusCode).toBe(201);
    const creado = await app.inject({
      method: 'POST',
      url: `${base}/asientos`,
      cookies: c,
      payload: {
        fecha: '2026-10-29',
        glosa: 'Depósito inicial',
        lineas: [
          { cuenta: '1.1.02', debe: 250000 },
          { cuenta: '1.1.01', haber: 250000 },
        ],
      },
    });
    expect(creado.statusCode).toBe(201);
    expect(creado.json().numero).toBe(1);
    const descuadrado = await app.inject({
      method: 'POST',
      url: `${base}/asientos`,
      cookies: c,
      payload: { fecha: '2026-10-29', glosa: 'Malo', lineas: [{ cuenta: '1.1.02', debe: 1 }, { cuenta: '1.1.01', haber: 2 }] },
    });
    expect(descuadrado.statusCode).toBe(422);
    expect(descuadrado.json().error.mensaje).toMatch(/descuadrado/u);
    const balance = await app.inject({ method: 'GET', url: `${base}/balance-8-columnas?hasta=2026-12-31`, cookies: c });
    expect(balance.json()).toMatchObject({ cuadrado: true, sumas: { debitos: '250000.00' } });
    const mayor = await app.inject({ method: 'GET', url: `${base}/mayor?cuenta=1.1.02&desde=2026-10-01&hasta=2026-10-31`, cookies: c });
    expect(mayor.json().saldoFinal).toBe('250000.00');
  });

  it('la cadena de la bitácora sigue íntegra después de todo lo anterior', async () => {
    const { rows } = await e.owner.query<{ alterado: string | null }>('SELECT bitacora_verificar() AS alterado');
    expect(rows[0]!.alterado).toBeNull();
  });
});

