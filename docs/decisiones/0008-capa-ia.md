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
4. **Ninguna credencial llega a un modelo.** Un mensaje de una persona que parece incluir una
   contraseña, clave, PIN, token o código de acceso se rechaza (422 `CREDENCIALES_EN_MENSAJE`)
   antes de llamar a cualquier modelo, incluso el local, y no se guarda. Además, antes de llamar
   a un modelo en la nube se ocultan los secretos que pudieran venir en datos de herramientas
   (contraseñas, certificados, llaves de API, hashes, campos como `claveSii` o `mfaSecret`):
   `src/ia/sensibles.ts`. Esa segunda barrera falla hacia el lado seguro (puede ocultar de más).
5. **Consumo inmutable.** Cada llamada queda en `uso_ia` (sin UPDATE, DELETE ni TRUNCATE) con
   tokens, costo en US$ con el precio vigente a la fecha (incluido el tramo de Haiku sobre
   100.000 tokens de entrada) y resultado. `ia_registrar_uso` rechaza un modelo que no esté en la
   política vigente. El reporte convierte a pesos con el dólar observado (indicador `DOLAR`,
   hasta 10 días hacia atrás) y advierte si falta precio o dólar.
6. **Precios como datos con vigencia.** La migración carga los precios oficiales de Claude
   Haiku, Sonnet y Opus 5.5 consultados el 2026-10-30 en
   https://platform.claude.com/docs/en/about-claude/pricing. Los cambios se cargan con
   `npm run cli:ia -- precio <modelo> <desde> <usd_entrada_por_millón> <usd_salida_por_millón> <fuente> <url_fuente> [<umbral> <entrada_sobre_umbral> <salida_sobre_umbral>]`.
   Con cupo `SOLO_LOCAL`, un modelo en la nube sin precio vigente no se usa (su costo no se
   podría medir).
7. **Límites de uso.** Plazo total por consulta (`IA_PLAZO_CONVERSACION_MS`, 120 s por omisión,
   para todos los pasos y respaldos), máximo 10 consultas por minuto y 2 simultáneas por
   persona, 6 simultáneas por empresa, y el cupo se revisa en cada paso. Los límites viven en
   la memoria del proceso: con varios servidores habrá que moverlos a la base o a Redis.
8. **Errores del proveedor.** La persona y `uso_ia` solo ven un texto genérico (por ejemplo
   "El proveedor respondió con error (HTTP 529)"); el detalle del proveedor, filtrado, queda en
   el registro del servidor.
9. **Configuración de proveedores** por variables de entorno (`ANTHROPIC_API_KEY`,
   `GEMINI_API_KEY`, `OLLAMA_URL`, `OLLAMA_MODELO`, `IA_TIMEOUT_MS`). Un proveedor sin
   configurar se salta en la cadena.
10. **Conversaciones privadas.** Solo quien inició una conversación puede continuarla; se
    verifica con una función que no depende de lo que la persona alcanza a ver.

## Pantallas

- **Asistentes**: conversación con cada agente; muestra el modelo que respondió.
- **IA**: modelos por agente (editable por el administrador del Cliente ERP, para una empresa o
  para todas) y consumo del período con cupo.

## Pendiente

- Cargar el cupo de cada Cliente ERP y, si se usa Gemini, sus precios oficiales.
- Sincronizar el dólar observado: requiere clave de la API CMF o una fuente verificada.
- Conector de WhatsApp y voz sobre el mismo endpoint de conversación.
