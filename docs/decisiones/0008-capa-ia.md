# 0008 — Capa de IA: modelos por agente, respaldo, cupo y consumo

## Contexto

Cada agente debe poder trabajar con un modelo local (Ollama) cuando la tarea lo permite, con
un modelo en la nube como respaldo, o directamente con Claude o Gemini. El Cliente ERP debe
ver cuántos tokens y cuánto dinero consume cada empresa y agente.

## Decisiones

1. **Política por niveles.** `politicas_ia` define una cadena ordenada de modelos. Se aplica la
   más específica vigente: empresa + agente > empresa > Cliente ERP + agente > Cliente ERP >
   plataforma + agente > plataforma. Los cambios dejan versión anterior (`REEMPLAZADA`) y motivo.
2. **Enrutador con respaldo.** `ModeloEnrutado` prueba la cadena en orden. Registra cada intento
   (OK, ERROR, NO_CONFIGURADO, OMITIDO_POR_CUPO). Si ninguno responde, la API devuelve 503
   `IA_NO_DISPONIBLE`; el agente no inventa una respuesta.
3. **Cupo mensual por Cliente ERP** (`cupos_ia`, en US$). Al excederlo: `CONTINUAR` (se factura
   aparte) o `SOLO_LOCAL` (se saltan los modelos en la nube).
4. **Datos sensibles nunca salen a la nube.** Antes de llamar a un modelo no local se ocultan
   contraseñas, claves tributarias, certificados, llaves de API, tokens y hashes
   (`src/ia/sensibles.ts`). Los modelos locales reciben el texto sin cambios porque no salen del
   servidor. El filtro es una segunda barrera: las herramientas de los agentes ya no exponen
   esos campos.
5. **Consumo inmutable.** Cada llamada queda en `uso_ia` con tokens, costo en US$ calculado con el
   precio vigente a la fecha, y resultado. El reporte convierte a pesos con el dólar observado
   (indicador `DOLAR`, hasta 10 días hacia atrás) y advierte si falta precio o dólar.
6. **Precios como datos con vigencia.** No se sembraron precios de Claude ni Gemini porque no se
   pudieron verificar contra las páginas oficiales al momento de esta entrega. Se cargan con
   `npm run cli:ia -- precio <modelo> <desde> <usd_entrada_por_millón> <usd_salida_por_millón> <fuente> <url_fuente>`.
   Mientras no haya precio, el reporte muestra tokens y advierte que el costo no está incluido.
7. **Configuración de proveedores** por variables de entorno (`ANTHROPIC_API_KEY`,
   `GEMINI_API_KEY`, `OLLAMA_URL`, `OLLAMA_MODELO`, `IA_TIMEOUT_MS`). Un proveedor sin
   configurar se salta en la cadena.

## Pantallas

- **Asistentes**: conversación con cada agente; muestra el modelo que respondió.
- **IA**: modelos por agente (editable por el administrador del Cliente ERP, para una empresa o
  para todas) y consumo del período con cupo.

## Pendiente

- Cargar precios oficiales vigentes y el cupo de cada Cliente ERP.
- Sincronizar el dólar observado: requiere clave de la API CMF o una fuente verificada.
- Conector de WhatsApp y voz sobre el mismo endpoint de conversación.
