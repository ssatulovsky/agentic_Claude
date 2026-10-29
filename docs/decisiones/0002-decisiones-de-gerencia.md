# 0002 · Decisiones de gerencia que guían las fases siguientes

Fecha: 2026-10-29 · Decide: Gerente General

| Tema | Decisión | Cómo se implementa |
| --- | --- | --- |
| Modelo de negocio | SaaS multiempresa con Cliente ERP y clientes ancla | Ya implementado en la Fase 0 |
| Construcción | Claude escribe el código en GitHub; un responsable técnico revisa y despliega | Cada fase se entrega por pull request con pruebas en CI |
| Facturación electrónica | Plataforma abierta propia, sin costo extra ni dependencia de un tercero | Ver abajo |
| Infraestructura | Servidor propio con respaldos administrados | Ver abajo |
| Modelo de IA | Se define con las pruebas de calidad de la Fase 1 | Ver abajo |
| WhatsApp | Respetar el conector web existente | Ver abajo |
| Precios | Por módulo y empresa, con un tramo de uso de IA incluido | Medición de tokens y costo por empresa, agente y modelo |
| Reapertura de períodos | Los períodos cerrados se pueden reabrir en casos excepcionales | Ver abajo |

## Facturación electrónica propia

Emisión de DTE sin intermediarios: firma XML con el certificado digital de la empresa, timbre (TED) con la clave privada del CAF, envío al SII, consulta de estado, folios correlativos tomados del CAF con bloqueo (nunca al azar) y alerta cuando quedan pocos folios. Como base se evaluará una librería de código abierto (por ejemplo LibreDTE, cuya licencia AGPL debe revisarse para un SaaS) frente a una implementación propia del estándar.

Requisito ineludible: cada empresa emisora debe pasar el **proceso de certificación del SII** (set de pruebas, simulación, intercambio y muestras impresas) en el ambiente de certificación antes de emitir en producción. El sistema debe incluir el flujo para ejecutar y documentar esa certificación.

## Servidor propio

El despliegue debe incluir: respaldos cifrados diarios con copia fuera del servidor y prueba de restauración mensual, replicación o respaldo continuo de PostgreSQL (WAL), gestor de secretos (no archivos `.env` en disco), TLS, cortafuegos, monitoreo con alertas y actualizaciones de seguridad. El responsable técnico define el proveedor de respaldos administrados.

## Enrutamiento de modelos de IA por agente

Cada agente tiene niveles configurables por empresa:

1. **Modelo local** (por ejemplo Ollama) cuando la tarea lo permite: clasificar, resumir, extraer datos.
2. **Respaldo en la nube** (Gemini o Claude) si el local falla o no alcanza la calidad mínima de esa tarea.
3. **Nube directa** cuando la empresa así lo decide para un agente.

La calidad mínima por tarea se mide con el banco de pruebas de cada agente (Fase 1). Cada llamada registra empresa, agente, proveedor, modelo, tokens de entrada y salida, costo en dólares y en pesos, y si fue respaldo. Con eso se emite el **reporte de consumo y costo por cliente** y se controla el tramo de IA incluido en el plan. Los datos sensibles (claves, certificados) nunca se envían a ningún modelo.

## WhatsApp con el conector web existente

Se respeta la decisión. Se deja registrado el riesgo: el conector web no es la API oficial de WhatsApp Business. Meta puede bloquear el número sin aviso, y la conexión puede caerse cuando WhatsApp cambia su protocolo. Mitigaciones de diseño:

- el canal queda detrás de una interfaz propia, de modo que pasar a la API oficial sea un cambio de conector y no de agentes;
- el número debe ser uno dedicado, nunca el personal de alguien;
- se vigila el estado de la conexión y se alerta si cae;
- la web queda siempre como canal de respaldo para aprobaciones.

## Cierre y reapertura de períodos

Un período cerrado queda bloqueado para registrar. La reapertura es una excepción controlada:

| Caso | Autorización requerida | Registro |
| --- | --- | --- |
| Reabrir un **mes** de un ejercicio que aún no se cierra | Persona con permiso de cierre contable (por ejemplo, el contador), indicando el motivo | Bitácora con motivo, quién y cuándo; se notifica al Gerente General |
| Reabrir un **ejercicio (año) cerrado** | Autorización del Directorio: al menos dos aprobaciones de personas con rol de director o equivalente, con referencia al acta | Bitácora con el acta, aprobadores y motivo; la reapertura vence en un plazo fijado |

Al volver a cerrar se recalculan los saldos y se deja constancia de las diferencias respecto del cierre anterior. Ningún agente puede reabrir un período: solo puede proponerlo.
