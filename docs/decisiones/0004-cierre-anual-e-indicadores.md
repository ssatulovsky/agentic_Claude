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
