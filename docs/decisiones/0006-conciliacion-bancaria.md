# 0006 · Conciliación bancaria (Fase 1.4)

Fecha: 2026-10-30

## Alcance

- Cuentas bancarias de la empresa, cada una asociada a una cuenta contable imputable de activo.
- Importación de cartolas:
  - la cartola de **Scotiabank Empresas** en Excel (.xls), con el formato del archivo real de septiembre de 2026;
  - la misma tabla en CSV, o en otra planilla con las columnas Fecha, Descripción, Cargo, Abono y Saldo.
- Conciliación de movimientos del banco con líneas de la cuenta contable del banco. Puede ser uno a uno o varios con varios, siempre que el neto sea igual.
- Contabilización de un movimiento: registra el asiento (banco contra la cuenta indicada) y lo concilia en la misma operación.
- Reglas de clasificación por RUT de la contraparte o por texto de la descripción. Las sugerencias usan esas reglas y nunca contabilizan solas.
- Informe de conciliación a una fecha.
- Nuevo agente **Tesorero**. Consulta, sugiere y propone; una persona aprueba.
- Todo requiere el módulo **Tesorería** contratado.

## Decisiones

- **Lector .xls propio.** Las cartolas de Scotiabank vienen en Excel 97-2003 (BIFF8). La versión de la biblioteca más usada que está en npm tiene vulnerabilidades conocidas al leer archivos subidos por usuarios, y la versión corregida no se publica en npm. Por eso el sistema lee el contenedor con `cfb` y los registros de celdas con un lector propio y acotado: solo la primera hoja, solo valores, y límites de tamaño, filas y columnas. Se verificó contra `xlrd` (Python) con la cartola real y con una de 400 movimientos, que tiene la tabla de textos partida en varios registros: el resultado es idéntico.
- **La cartola debe cuadrar** o no se importa. Se verifica que:
  - saldo anterior + abonos − cargos = saldo final;
  - los movimientos sumen los totales;
  - cada saldo diario cuadre con el anterior;
  - las fechas estén dentro del período;
  - el número de cuenta de la cartola coincida con la cuenta elegida.
- **Cartolas traslapadas.** Cada movimiento se identifica por cuenta, fecha, descripción, monto y número de repetición ese día. Así, importar una cartola que se traslapa con otra agrega solo los movimientos nuevos, y dos transferencias iguales el mismo día no se confunden. Si falta una cartola entre dos períodos, el sistema lo advierte.
- **Inmutabilidad.**
  - Cartolas y movimientos no se modifican ni se borran.
  - Una conciliación se anula con motivo y queda en el historial.
  - No se concilian líneas de apertura, de cierre ni de asientos reversados.
  - Si un asiento se reversa después de conciliarlo, el informe lo advierte.
- **Informe:**
  - **saldo del banco:** saldo anterior de la primera cartola más los movimientos hasta la fecha;
  - **saldo contable:** líneas de la cuenta del banco en el ejercicio de la fecha, incluida la apertura;
  - **saldo conciliado:** saldo contable + movimientos del banco sin contabilizar − partidas contables que aún no pasan por el banco;
  - cuadra si la diferencia es cero y no hay advertencias.
  - La conciliación parte con la primera cartola importada. Lo anterior es historia que no se concilia.
- **Sugerencias.** No escriben nada. Para cada movimiento pendiente, el sistema hace lo primero que aplique:
  1. busca un asiento del mismo monto, dentro de 7 días;
  2. si no hay, busca una regla de clasificación;
  3. si tampoco hay, deja el movimiento sin sugerencia para que una persona lo clasifique.

  En todos los casos muestra como evidencia los documentos del RCV de la misma contraparte y monto. Por ejemplo, el cobro de $3.750.000 de septiembre aparece junto a las facturas 55 y 56 de agosto.
- **Agentes.** El Tesorero no clasifica sin regla ni instrucción. Si un movimiento no tiene regla, pregunta qué es.
  - Contabilizar y conciliar son propuestas que aprueba una persona con los permisos de tesorería y del libro diario.
  - La conciliación queda con origen `AGENTE_APROBADO`.
  - El asiento lo registra la persona que aprueba, con origen `MANUAL`, porque el libro diario solo acepta asientos de agente desde la herramienta de asientos.

## Pendiente con el contador

1. **Tratamiento de las transferencias a personas** que aparecen en la cartola de septiembre: a un socio y a otra persona. Pueden ser retiros, préstamos, remuneraciones u honorarios. Cada caso se registra en una cuenta distinta y tiene efectos tributarios distintos. Cuando se defina, se crea una regla por RUT y el sistema las propondrá solas.
2. **Cuentas del plan:** clientes, cuenta corriente del socio y comisiones bancarias.
3. **Saldo inicial:** el banco tenía $81.000 al 01-09-2026; debe coincidir con el saldo contable a esa fecha.
