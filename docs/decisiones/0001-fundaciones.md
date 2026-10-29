# 0001 · Decisiones de la Fase 0

Fecha: 2026-10-29

## PostgreSQL con seguridad por fila (RLS) como garante del aislamiento

**Decisión.** Toda tabla con datos de una empresa tiene políticas RLS. La aplicación se conecta con `erp_app`, que no es dueño de las tablas y tiene `NOBYPASSRLS`. Cada transacción declara `app.usuario_id` y `app.empresa_id` con `set_config(..., true)`. Las políticas verifican además que ese usuario tenga acceso real a esa empresa.

**Por qué.** En un SaaS multiempresa, una consulta mal filtrada es una fuga de datos. Con RLS, un error en el código devuelve cero filas en vez de los datos de otro cliente.

**Costo.** Las funciones de política se ejecutan por fila. Es aceptable con los volúmenes de la Fase 0; en la Fase 1 se medirá con datos reales y, si hace falta, se cachea el resultado de acceso por transacción.

## Contraseñas y sesiones solo detrás de funciones `SECURITY DEFINER`

`erp_app` no puede leer `password_hash`, `totp_secreto_cifrado` ni la tabla `sesiones`. Todo pasa por funciones `auth_*` con lo mínimo necesario. El contador de intentos fallidos solo se reinicia con un ingreso completo (contraseña y doble factor).

## Bitácora encadenada

Cada evento guarda `sha256(contenido canónico ‖ hash anterior)`. Triggers rechazan `UPDATE`, `DELETE` y `TRUNCATE` incluso al dueño. Un superusuario puede saltarse los triggers, pero la verificación detecta el cambio. Pendiente para producción: anclar periódicamente el último hash fuera de la base de datos (correo firmado o almacenamiento inmutable) para detectar también un reemplazo completo de la cadena.

La aplicación usa el nivel de aislamiento `READ COMMITTED`, que la cadena necesita para leer el último eslabón después de tomar el candado.

## La IA propone, el núcleo decide

Los agentes actúan con la identidad de la persona que pregunta. Una herramienta se ejecuta solo si: está asignada al cargo del agente, la entrada es válida, la empresa tiene el módulo, el agente está activo y la persona tiene el permiso. Lo que modifica datos queda como propuesta, y quien la aprueba necesita `agentes.aprobar` **y** el permiso propio de la herramienta.

El modelo de lenguaje se conecta mediante la interfaz `ModeloIA`, independiente del proveedor. La elección del proveedor queda para la Fase 1, con pruebas de calidad por agente.

## Normativa con vigencia

Parámetros y tablas legales con rango de vigencia `[desde, hasta)`, fuente con URL, estado y aprobador. Una restricción de exclusión impide dos valores aprobados superpuestos. Si no hay valor vigente, el cálculo falla con `PARAMETRO_NO_VIGENTE`.

## Montos

Los cálculos legales usan enteros (centavos y diezmilésimos con `BigInt`) y las columnas `numeric` se leen como texto, para no perder precisión por coma flotante.

## Revisión de seguridad independiente (29-10-2026)

Un revisor que no participó en la construcción auditó la Fase 0 e intentó ataques reales contra una base de datos desechable. Se corrigieron todos sus hallazgos, cada uno con una prueba:

| Hallazgo | Corrección |
| --- | --- |
| Bloqueo por intentos evitable con peticiones en paralelo (200 intentos de doble factor pasaron) | Cada intento reserva un cupo con bloqueo de fila antes de verificarse |
| `trustProxy: true` permitía falsear la IP del límite de intentos | Solo se confía en los N proxies propios (`PROXIES_CONFIABLES`) |
| Propuestas vencidas quedaban pendientes para siempre | Se marcan `VENCIDA` con quién lo constató |
| Una tabla de impuesto con huecos daba impuesto 0 en silencio | La tabla se valida (contigua, desde 0, último tramo abierto) y una renta sin tramo es un error |
| La cadena de bitácora podía bifurcarse en `REPEATABLE READ` | Cabeza de la cadena en una fila con bloqueo; la verificación también controla la cabeza |
| `erp_app` podía fabricar sesiones y escribir eventos a nombre de otros | Funciones de autenticación solo para el nuevo rol `erp_auth`; la bitácora valida la identidad del actor |
| Bitácora visible sin el permiso `bitacora.ver` | La política exige el permiso |
| Verificación global de la bitácora expuesta a los clientes | Pasó a ser una operación de plataforma (`cli:verificar-bitacora`) |
| Forma canónica ambigua del hash | Arreglo JSON escapado |
| El bloqueo se podía renovar indefinidamente y revelaba que la cuenta existe | El contador vuelve a cero al vencer el bloqueo; mismo mensaje para cuenta bloqueada o inexistente |
| Secreto del doble factor reemplazable durante la activación | Activación atómica contra el secreto verificado |
| Ciclos posibles en el plan de cuentas | El trigger recorre los ancestros |
| POST sin cuerpo saltaba la protección CSRF | Exige la cabecera `X-ERP-Solicitud: 1` |

**Riesgo residual aceptado.** El rol `erp_app` puede declarar cualquier `app.usuario_id`: la seguridad por fila protege contra errores de filtrado en el código, no contra un servidor de aplicación completamente comprometido. Mitigación futura: firmar el contexto de sesión dentro de la base de datos. Los correos y teléfonos son únicos en toda la plataforma (necesario para el ingreso), lo que permite a un administrador saber que un correo ya existe en otro cliente.
