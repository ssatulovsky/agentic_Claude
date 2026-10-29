# ERP Agéntico

ERP multiempresa para Chile en el que un equipo de agentes de IA atiende la administración y las finanzas, y un núcleo transaccional determinista valida, calcula y registra todo.

> **Estado: Fase 0 (Fundaciones) completa.** Seguridad, datos multiempresa, bitácora inmutable, motor de normativa y marco de agentes. Todavía no hay interfaz web ni contabilidad transaccional (eso llega en la Fase 1). Ver el plan maestro.

## Principios

1. **La IA propone, el núcleo decide.** Ningún modelo calcula un impuesto, un sueldo o un saldo. Los agentes usan herramientas del núcleo.
2. **Una sola fuente de verdad:** PostgreSQL. Nada de negocio vive en el navegador.
3. **Seguridad en la base de datos.** El aislamiento entre empresas lo aplica PostgreSQL con seguridad por fila (RLS), no la buena voluntad del código.
4. **Bitácora inmutable** encadenada con SHA-256. Ni el dueño de la tabla puede borrar o modificar eventos.
5. **Normativa con vigencia y fuente.** Ningún valor legal está escrito en el código. Si falta un valor vigente, el sistema se detiene en vez de suponerlo.
6. **Aprobación humana para lo que modifica datos.** Lo que no es una consulta queda como propuesta, y quien la aprueba debe tener también el permiso para hacerlo por sí mismo.

## Modelo de clientes

```
Cliente ERP (quien contrata, p. ej. un estudio contable)
  ├── Empresa PROPIA
  └── Clientes ANCLA (empresas atendidas), cada una con sus módulos contratados
```

- Un usuario existe bajo un Cliente ERP y accede a empresas con un rol por empresa (`membresias_empresa`) o a todas las del Cliente ERP (`membresias_cliente_erp`).
- Cada empresa contrata módulos (`suscripciones_modulo`), pagados por el Cliente ERP o por la propia empresa.

## Estructura

```
db/
  bootstrap.sql            Roles erp_owner (migraciones), erp_auth (autenticación) y erp_app (aplicación); los dos últimos NOBYPASSRLS
  migraciones/             SQL versionado; una migración aplicada no se edita
src/
  config.ts                Configuración validada al arrancar (sin secretos por defecto)
  db/                      Conexión, contexto de seguridad por transacción, migrador
  seguridad/               Contraseñas Argon2id, TOTP (RFC 6238), cifrado AES-256-GCM, sesiones, permisos
  bitacora/                Registro y verificación de la cadena
  normativa/               Parámetros legales por fecha, indicadores, impuesto único
  agentes/                 Catálogo de agentes, herramientas, ejecutor con permisos, ciclo de conversación
  api/                     API HTTP (Fastify)
  cli/                     Alta de un Cliente ERP
test/                      Pruebas contra PostgreSQL real
docs/decisiones/           Registro de decisiones de arquitectura
```

## Puesta en marcha local

Requisitos: Node.js 22 y PostgreSQL 16 (o Docker).

```bash
npm ci
docker compose up -d postgres
docker compose exec postgres psql -U postgres \
  -v owner_pass=owner_local -v app_pass=app_local -v auth_pass=auth_local -v db=erp -f /bootstrap.sql

cp .env.example .env      # complete las claves; CLAVE_MAESTRA_CIFRADO con: openssl rand -hex 32
npm run db:migrar
npm run cli:crear-cliente-erp -- --rut 76.104.550-4 --razon-social "Estudio Demo SpA" \
  --admin-email admin@demo.cl --admin-nombre "Admin Demo"
npm run dev
```

Al primer ingreso el administrador debe configurar el doble factor (`POST /api/auth/mfa/enrolar` y luego `/activar`).

Toda petición que modifica datos debe ser JSON; las que no llevan cuerpo (cerrar sesión, enrolar) deben traer la cabecera `X-ERP-Solicitud: 1` (protección CSRF).

Verificación diaria de la bitácora (operación de plataforma, con la conexión de migraciones):

```bash
npm run cli:verificar-bitacora   # imprime el hash de la cabeza para anclarlo fuera de la base de datos
```

## Pruebas

```bash
TEST_PG_ADMIN_URL=postgres://postgres:postgres_local@localhost:5432/postgres npm test
```

Cada ejecución crea una base de datos nueva, aplica todas las migraciones y la elimina al terminar. Las pruebas cubren:

- **Aislamiento:** un usuario no ve ni escribe datos de otra empresa aunque la declare como contexto. Sin contexto no se ve nada. La aplicación no puede leer contraseñas, secretos ni sesiones.
- **Autenticación:** doble factor obligatorio, enrolamiento, bloqueo tras 5 intentos aun con 100 intentos en paralelo, mismo mensaje para cuenta bloqueada o inexistente, protección contra repetición de códigos, límite por IP y cierre de sesión en el servidor. La aplicación general no puede usar las funciones de autenticación.
- **Bitácora:** auditoría automática de cambios, inmutabilidad incluso para el dueño de la tabla, nadie registra a nombre de otro, sin bifurcaciones bajo concurrencia, y detección de una alteración hecha por un superusuario.
- **Normativa:** valores por fecha, cálculo del impuesto único verificado contra la tabla del SII de octubre 2026, y rechazo de valores superpuestos.
- **Agentes:** permisos de la persona, módulos contratados, herramientas por cargo, propuestas con aprobación, trazas completas y tope de pasos.
- **TOTP:** vectores oficiales del RFC 6238.

## API (Fase 0)

| Método y ruta | Uso |
| --- | --- |
| `POST /api/auth/login` | Correo y contraseña; deja una sesión pendiente de doble factor |
| `POST /api/auth/mfa/enrolar` · `/activar` · `/verificar` | Doble factor |
| `POST /api/auth/logout` | Cierra la sesión en el servidor |
| `GET /api/yo` | Usuario y empresas a las que tiene acceso |
| `POST /api/empresas` | Crear empresa propia o ancla (administrador del Cliente ERP) |
| `GET/POST /api/empresas/:id/suscripciones` | Módulos contratados |
| `GET /api/empresas/:id/permisos` | Permisos efectivos del usuario |
| `POST /api/usuarios` · `POST /api/usuarios/:id/membresias` | Usuarios y roles |
| `GET/POST/PATCH /api/empresas/:id/plan-cuentas` | Plan de cuentas |
| `GET/POST /api/empresas/:id/terceros` · `/centros-costo` | Maestros |
| `GET /api/empresas/:id/normativa/parametros/:clave?fecha=` | Parámetro legal con fuente |
| `GET /api/empresas/:id/normativa/indicadores/:tipo?fecha=` | UF, UTM, UTA |
| `GET /api/empresas/:id/bitacora` | Auditoría de la empresa |
| `GET /api/agentes` · `GET /api/empresas/:id/propuestas` · `POST …/propuestas/:id/resolver` | Agentes y aprobaciones |

## Normativa cargada

La migración `0007` carga los valores de 2026 verificados el 29-10-2026 contra Previred, el SII, la Superintendencia de Pensiones (vía AAFP), ChileAtiende y la Dirección del Trabajo: ingreso mínimo (Leyes 21.751 y 21.830), topes imponibles (90 UF y 135,2 UF), tasas AFP, la cotización del empleador de la Ley 21.735 (3,5% desde agosto 2026), seguro de cesantía, salud, gratificación del artículo 50 y la tabla del impuesto único. **El contador responsable debe ratificarlos antes de la Fase 4.**

## Próximo paso: Fase 1

Libro diario con reversas, mayor, balance de 8 columnas y cierre mensual; RCV desde el SII; propuesta de F29; conciliación bancaria; sincronización diaria de UF y UTM; conexión del primer modelo de IA; Contralor; e interfaz web.
