# 0004 · Cierre anual e indicadores (Fase 1.2)

Fecha: 2026-10-29

## Cierre anual

- **Cuenta de resultado del ejercicio.** Es configurable por empresa y debe ser de patrimonio, imputable y activa. Sin ella no se cierra.
- **Asiento de CIERRE.** Va fechado el último día del ejercicio y con origen `MODULO`. Salda cada cuenta de ingreso y gasto: un saldo neto deudor (pérdida) va al debe de la cuenta de resultado y uno acreedor (utilidad) al haber.
- **Asiento de APERTURA.** Va el primer día del ejercicio siguiente, que se crea si no existe. Lleva los saldos de las cuentas de activo, pasivo, patrimonio y orden, agrupados por cuenta, tercero y centro de costo, para conservar las partidas abiertas por proveedor o cliente.
- **Asientos del sistema.** Cierre, apertura y sus reversas se registran sin validar que el período esté abierto, porque se generan justamente al cerrar. Se numeran en el correlativo de su ejercicio y quedan en la bitácora.
- **Reapertura del ejercicio.** Al aprobarse, el sistema reversa automáticamente el cierre y la apertura automática del ejercicio siguiente. Al volver a cerrar, ambos se regeneran.
- **Límites:**
  - Una apertura manual vigente en el ejercicio siguiente detiene el cierre hasta que se reverse.
  - No se puede pedir reabrir un ejercicio si uno posterior ya está cerrado.
  - El asiento de cierre no se reversa a mano.
- **Reportes.** Excluyen el cierre y sus reversas, de modo que el balance del año cerrado sigue mostrando su resultado.

**Fuera de alcance (por ahora):** el traspaso del resultado del ejercicio a "resultados acumulados" al inicio del año siguiente. Lo registra el contador como asiento normal, o se automatizará cuando Mario Vargas confirme el criterio de la empresa.

## Indicadores

- **Fuentes:** mindicador.cl, que reproduce los valores del Banco Central, y la API de la CMF si hay clave. El formato de la CMF se implementó según su forma conocida (`UFs` y `UTMs`, con valores del tipo "41.247,63") y debe confirmarse con una clave real antes de producción.
- **Fechas:** mindicador entrega la medianoche de Chile expresada en UTC (03:00 o 04:00 según el horario de verano). Se convierte a fecha chilena.
- **Conciliación:** con dos fuentes se exige coincidencia al centavo. Nunca se sobrescribe un valor guardado. Se rechazan variaciones inverosímiles. Todo queda en la bitácora con el detalle.
- **UTA:** se calcula como 12 × UTM del mes. Coincide con Previred para octubre de 2026 ($72.151 × 12 = $865.812).
- **Ejecución:** la sincronización es una operación de plataforma (rol `erp_owner`), porque la aplicación no puede escribir indicadores. Se programa con cron en el servidor.

## Revisión independiente (29-10-2026)

El revisor, con mirada de contador auditor y de ingeniero de bases de datos, comprobó el cierre anual con una prueba de propiedades:
- primer ejercicio iniciado a mitad de año, tres años de asientos aleatorios y tres ciclos de reapertura y cierre;
- proveedores y clientes con saldos que se anulan, centros de costo, cuentas de orden, y años con utilidad y con pérdida.

En todos los casos la apertura de cada año coincidió al peso, por cuenta, tercero y centro de costo, con los saldos al cierre del anterior. También encontró los siguientes problemas, todos corregidos con pruebas:

| Gravedad | Hallazgo | Corrección |
| --- | --- | --- |
| Crítica | La migración 0009 no retiraba el permiso de ejecución por defecto (`ALTER DEFAULT PRIVILEGES … IN SCHEMA` no revoca lo que PostgreSQL concede en forma global). Las funciones internas del cierre quedaban ejecutables por cualquier rol, incluso entre empresas. | `ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner` sin esquema, revocación de todas las funciones, verificación de empresa dentro de los asientos de sistema y una prueba de que ninguna función es ejecutable por PUBLIC. |
| Alta | Una reapertura vencida sin volver a cerrar permitía cerrar el año siguiente sin cierre ni apertura vigentes. | Un año reabierto y no vuelto a cerrar bloquea el cierre de los siguientes; tampoco se cierra N si N+1 ya está cerrado. |
| Alta | La aprobación de una reapertura no verificaba que el año siguiente siguiera abierto. | Se bloquean los años posteriores y se rechaza si alguno se cerró. |
| Media | El origen `MODULO` se podía falsificar, y la apertura automática se podía reversar a mano. | El registro manual rechaza `MODULO`; la apertura automática solo la reversa el sistema. |
| Media | Con dos fuentes, si una fallaba se guardaba lo de la otra sola. | Con dos fuentes configuradas, se exige que ambas confirmen cada valor. |
| Media | La verosimilitud solo miraba hacia atrás y sin referencia aceptaba cualquier cosa. | Compara con los valores vecinos de ambos lados, a no más de 45 días (UF) o 3 meses (UTM). Sin referencia, exige dos fuentes. |
| Media | Reportes lentos: la seguridad por fila se evaluaba en cada línea (7 s con 80 asientos en una base sin estadísticas). | Funciones de reporte que verifican el permiso una vez y leen por índice: 34 ms con 3.000 asientos. |
| Baja | Líneas sin debe o haber, cuenta de resultado no revalidada al cerrar, conflictos de UTA silenciosos, fechas duplicadas en una fuente, valores con más de 2 decimales, ejecuciones simultáneas de la sincronización. | Corregidos (`coalesce`, revalidación, informe de conflictos, rechazo de duplicados y decimales, transacción con candado). |

**Pendiente, documentado:**
- Los asientos de sistema modifican el enero del año siguiente aunque ese mes esté cerrado. Es intencional, porque la apertura debe regenerarse, y queda registrado en la bitácora.
- Las cuentas de orden no se obligan a cuadrar entre sí.
