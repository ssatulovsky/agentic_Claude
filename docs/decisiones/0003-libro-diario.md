# 0003 · Libro diario (Fase 1.1)

Fecha: 2026-10-29

## Reglas implementadas en la base de datos

- Toda escritura contable pasa por funciones `contabilidad_*` (SECURITY DEFINER). La aplicación no tiene permiso para insertar, modificar ni borrar asientos.
- Partida doble exacta, montos con hasta 2 decimales, sin NaN; al menos dos líneas; cuentas imputables y activas; tercero y centro de costo cuando la cuenta los exige.
- Asientos y líneas inmutables (triggers que rechazan UPDATE, DELETE y TRUNCATE, también para el dueño). Se corrigen con una reversa vinculada, con fecha igual o posterior al original; una reversa replica el original aunque después se haya desactivado una cuenta o cambiado una exigencia.
- Asiento de apertura: solo el primer día del ejercicio y uno vigente por ejercicio. Los asientos de cierre se generarán con el cierre anual (próxima entrega).
- Un asiento marcado como de agente solo existe si proviene de una propuesta real de la misma empresa, aprobada en esa misma transacción.

## Numeración

El número del asiento es el **correlativo de registro** por ejercicio: sin saltos ni duplicados, aun con registros simultáneos (el ejercicio se bloquea en modo exclusivo mientras se asigna). Un asiento registrado en un mes reabierto recibe un número mayor que los de meses posteriores. El Libro Diario impreso se ordenará por fecha y llevará folio por página; el número de registro se conserva como referencia de auditoría.

## Períodos

- Un mes se cierra solo después de terminar (fecha de Chile) y después de los meses anteriores.
- Reabrir un mes del ejercicio en curso exige el permiso de períodos y un motivo, y **reabre también los meses posteriores ya cerrados**, para que se vuelvan a revisar y cerrar en orden.
- Un ejercicio se cierra con todos sus meses cerrados y con el ejercicio anterior cerrado.
- Cerrar meses o el ejercicio siempre está permitido; lo que se bloquea es registrar. Así, si vence una reapertura excepcional, todo puede volver a cerrarse sin otra autorización.

## Reapertura de un ejercicio cerrado

- La solicita quien puede cerrar el ejercicio, con motivo (20 caracteres o más), referencia al acta y plazo de 1 a 90 días.
- Se requieren dos aprobaciones de directores distintos, ninguno de ellos quien solicitó. Un rechazo cierra la solicitud.
- Un director solo puede autorizar si tiene el doble factor activo y fue designado en la empresa antes de la solicitud.
- El cargo de Director se asigna por empresa (nunca a nivel de Cliente ERP), y nadie puede asignarse roles a sí mismo.
- Una solicitud vencida no bloquea una nueva; su vencimiento queda en la bitácora.

## Reportes

- El balance de 8 columnas y el libro mayor cubren un solo ejercicio y acumulan desde su inicio (incluida la apertura). Los asientos de cierre no se incluyen.
- Las cuentas de orden se informan aparte y no afectan el inventario.
- El mayor de una cuenta de agrupación suma todas sus subcuentas.

## Revisión independiente

Un revisor con mirada de contador auditor y de ingeniero de bases de datos auditó la entrega con ataques reales. Encontró 3 problemas graves (montos NaN aceptados, un administrador podía simular dos directores, reportes que cruzaban ejercicios y se declaraban cuadrados), 8 medios y varios menores. Todos quedaron corregidos con pruebas, salvo los que se indican abajo.

## Pendiente (próximas entregas)

1. Cierre anual: asiento de cierre de cuentas de resultado y apertura automática del ejercicio siguiente, regenerada si el ejercicio se reabre.
2. Referencias estructuradas a documentos (tipo de DTE, folio, RUT emisor, fecha) para cuadrar con el RCV y el F29.
3. Libros auxiliares por tercero y centro de costo; estado de resultados y balance clasificado.
4. Homologación del plan de cuentas al balance tributario y códigos del F22.
5. Libros imprimibles con folio (Diario, Mayor, Inventarios y Balances).
6. Moneda extranjera y UF, diferencias de cambio y corrección monetaria cuando corresponda.
7. Importación de saldos iniciales y asientos tipo.
