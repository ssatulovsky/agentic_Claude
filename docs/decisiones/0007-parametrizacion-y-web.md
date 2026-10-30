# 0007 · Parametrización contable y primera pantalla web (Fase 1.5)

Fecha: 2026-10-30

## Pedido de la gerencia

- Clasificación de las transferencias de septiembre 2026 en la cuenta de Scotiabank:
  - las del socio son **retiros de socios**;
  - la de Matías Vera es **reintegro de un préstamo**, es decir, la empresa devuelve un préstamo recibido.
- Las cuentas se configuran "según lógica", pero deben poder cambiarse desde una **pantalla de parametrización**.

## Decisiones

- **Plan de cuentas base** (`plan_cuentas_base`). Es un plan tipo para una pyme chilena: 54 cuentas en 5 grupos. Se carga en una empresa con un botón, respeta las cuentas que la empresa ya tiene y se puede cargar varias veces sin duplicar nada.
- **Conceptos de imputación** (`conceptos_imputacion`). Son 23 conceptos: clientes, proveedores, IVA crédito y débito, remanente, PPM, retenciones, préstamos por cobrar y por pagar, cuenta corriente y retiros de socios, capital, resultados, ventas afectas y exentas, honorarios, gastos generales, IVA no recuperable y gastos bancarios. Cada concepto indica a qué clasificación de cuenta puede imputarse; por ejemplo, retiros de socios admite patrimonio, activo o pasivo.
- **Imputaciones por empresa** (`imputaciones`).
  - Cada cambio exige un motivo.
  - La versión anterior queda en el historial, que se ve en la pantalla.
  - Las imputaciones no se borran y las cambia una persona, nunca un agente.
  - Todo queda en la bitácora.
- **Reglas de conciliación por concepto.** Una regla puede apuntar a un concepto en vez de una cuenta fija. Si cambia la imputación, la regla usa la cuenta nueva sin tocarla. Si la cuenta exige tercero, la regla también lo exige.
- **Septiembre 2026, verificado de punta a punta con la réplica de la cartola real** (`test/parametrizacion.test.ts`):
  - **Socio:** 10 cargos por $2.991.000, imputados a Retiros de socios (3.1.02).
  - **Matías Vera:** 1 cargo por $50.000, imputado a Préstamos por pagar (2.1.08).
  - **Cobro del cliente:** 1 abono por $3.750.000, imputado a Clientes (1.1.03).
  - La conciliación al 28-09 cuadra: saldo del banco $790.000 = saldo contable.

## Interfaz web

- **Tecnología:** aplicación React + TypeScript compilada con Vite (`web/`), que el mismo servidor sirve en `/app/`, en el mismo dominio que la API. Así la cookie de sesión `SameSite=Strict` y la protección CSRF siguen funcionando sin cambios.
- **Política de contenido:** la interfaz solo carga scripts y estilos propios. La API mantiene `default-src 'none'`.
- **Pantallas:**
  1. Ingreso con contraseña y doble factor (TOTP), incluido el enrolamiento la primera vez.
  2. **Parametrización contable:** cada concepto con su cuenta vigente y solo las cuentas que admite. Cambiar una cuenta pide el motivo antes de guardar y cada concepto tiene su historial. Si la empresa no tiene plan, ofrece cargar el plan base.
  3. **Reglas de conciliación:** lista con el concepto y la cuenta vigente, creación por RUT o texto, y desactivación.
- La interfaz muestra o permite editar según los permisos de la persona en la empresa elegida. La seguridad no depende de la interfaz: la base de datos vuelve a verificar todo.
- Se revisó en navegador (escritorio y teléfono) con Playwright.
- **Dependencias:** se actualizó `@fastify/static` a 10.1.8, porque las versiones anteriores tienen vulnerabilidades de recorrido de rutas. `npm audit` no informa vulnerabilidades.

## Puesta en marcha para InnovAgile

1. Cargar el plan base desde la pantalla de parametrización y revisar las cuentas con Mario Vargas.
2. Crear los terceros: el socio y Matías Vera, con sus RUT.
3. Crear las reglas:
   - "Retiros del socio": cargo, RUT del socio, concepto Retiros de socios, tercero el socio.
   - "Reintegro de préstamo": cargo, RUT de Matías Vera, concepto Préstamos por pagar, tercero Matías Vera.
4. Registrar el saldo del banco al 31-08-2026 ($81.000) y el préstamo original de Matías Vera, si no está contabilizado. Sin ese préstamo, el reintegro deja la cuenta 2.1.08 con saldo deudor.
