# 0010 — Contralor: revisión independiente de propuestas y control de cifras

## Contexto

El plan maestro pide un Contralor independiente que revise toda propuesta de un agente antes
de registrarla, y que ninguna cifra de una respuesta quede sin fuente ("la IA propone, el
núcleo decide"). Hasta ahora las propuestas llegaban directo a la persona y la validación
real ocurría recién al aprobarse.

## Decisiones

1. **Determinista, no un modelo de IA.** El Contralor es código del núcleo. Un modelo puede
   explicar sus hallazgos (agente `CONTRALOR`), pero no decide.
2. **Ensayo antes de proponer.** Cada propuesta se ejecuta dentro de un punto de restauración,
   como se ejecutará al aprobarla (actor USUARIO, con una propuesta borrador del mismo id, que
   se crea al final, dentro del ensayo), y se deshace siempre: asientos, correlativos, bitácora e identidad declarada
   vuelven atrás. Así se detecta antes lo que fallaría al aprobar: cuentas inexistentes o no
   imputables, períodos cerrados, terceros faltantes, RCV no importado, conciliaciones que no
   cuadran. El ensayo corre con los permisos de quien pidió: si le falta uno que sí tendrá
   quien apruebe, queda una observación ("debe aprobarla alguien con todos los permisos"), no
   un rechazo. Una herramienta con efectos fuera de la base (enviar un DTE) se marca
   `ensayable: false` y no se ensaya.
3. **Dictamen.**
   - `RECHAZADA` (algún hallazgo bloqueante, o una propuesta idéntica ya pendiente de
     cualquier persona; dos pedidos idénticos simultáneos se serializan con un bloqueo): la
     propuesta no llega a nadie; el agente recibe los hallazgos para corregir o preguntar.
   - `OBSERVADA` (solo observaciones): llega a la persona, y aprobarla exige un motivo
     (también lo exige la base de datos).
   - `CONFORME`: llega sin observaciones.
4. **Criterio por herramienta.** Cada herramienta puede declarar `revisar`. Para los asientos:
   fecha futura o de hace más de 60 días, monto igual o mayor al umbral (por omisión
   $10.000.000; configurable por empresa y agente en `agentes_config_empresa.parametros.umbral_observacion_asiento`),
   glosa breve, una misma cuenta en el debe y el haber, y un asiento igual ya registrado.
5. **Registro inmutable.** Cada revisión queda en `revisiones_contralor` (también las
   rechazadas, que no llegan a ser propuesta), y el dictamen de una propuesta no se puede
   cambiar después.
6. **Control de cifras.** Al terminar cada respuesta, toda cifra (montos, porcentajes, números
   con miles o decimales, "$2,9 millones", "MM$"; no fechas, RUT, códigos de cuenta ni años)
   debe estar en los datos que entregaron las herramientas ejecutadas en esa conversación o
   en lo que dijo la persona. No cuentan como fuente: las respuestas anteriores del agente, lo
   que él mismo puso en las herramientas (resúmenes de propuestas, denegaciones), ni
   identificadores o marcas de tiempo de los datos. El signo importa: una pérdida informada
   como utilidad se marca. Una cifra redondeada a dos cifras significativas ("$2,9 millones")
   se respalda con el dato que redondea a ella. Si una cifra no tiene respaldo, la respuesta lleva un aviso del Contralor y
   queda en las trazas (`CONTROL_CIFRAS`). Un total calculado por el modelo se marca: los
   cálculos los hacen las herramientas.
7. **Pantalla de propuestas.** La web muestra las propuestas con el dictamen y los hallazgos,
   y quien tiene `agentes.aprobar` las aprueba (con motivo si están observadas) o rechaza.

## Pendiente

- Separación de funciones (que quien pidió no apruebe) como opción por empresa, cuando haya
  más de una persona con el permiso.
- Banco de preguntas reales para medir aciertos de los agentes (puerta de la Fase 1).
