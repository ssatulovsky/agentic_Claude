# 0009 — Canal WhatsApp detrás de un puente firmado

## Contexto

La gerencia decidió usar el conector web de WhatsApp que ya existe (ver 0002), con sus riesgos:
no es la API oficial, Meta puede bloquear el número y la conexión puede caerse. Las personas
deben poder conversar con los agentes por texto o nota de voz, con los mismos permisos que en
la web.

## Decisiones

1. **Interfaz propia + puente HTTP.** El ERP no habla con WhatsApp: habla con un puente (el
   conector) mediante un contrato HTTP firmado. Cambiar a la API oficial es otro adaptador del
   mismo contrato (`CanalMensajeria`), sin tocar agentes.
2. **Un número de plataforma.** Las personas se identifican por su teléfono, que es único en
   todo el sistema (`usuarios.telefono_whatsapp`, lo registra el administrador).
3. **Vinculación verificada.** La persona, con sesión y doble factor en la web, genera un código
   de 6 dígitos (vence en 10 minutos, 5 intentos) y lo envía desde el teléfono registrado:
   `VINCULAR 123456`. Así se prueba que tiene la cuenta y el teléfono. El vínculo vence a los
   90 días y se revoca si cambia el teléfono de la cuenta o se desactiva la persona.
4. **Mismos permisos, menos autonomía.** Por WhatsApp no hay doble factor por mensaje, así que
   ninguna acción se ejecuta directamente: las de "ejecutar con aviso" quedan como propuestas
   para aprobar en la web. Consultar sí se puede.
5. **Credenciales.** Un mensaje (o nota de voz transcrita) que parece traer una clave se rechaza
   sin llegar a ningún modelo y sin guardarse, igual que en la web.
6. **Notas de voz.** Se transcriben con un servicio compatible con `/v1/audio/transcriptions`
   (Whisper local por defecto: el audio no sale del servidor). La respuesta repite lo entendido
   («Entendí: …») para que la persona lo confirme. Los audios no se guardan.
7. **Sin contenido en la tabla de mensajes.** `mensajes_whatsapp` guarda solo metadatos (para no
   procesar dos veces un mensaje y para auditar). El texto queda en las trazas del agente, con
   sus reglas de acceso.
8. **Números desconocidos.** Reciben a lo más un aviso por hora; nada llega a los agentes.
9. **Vigilancia de la conexión.** El puente envía un latido cada minuto. Sin latido por más de
   3 minutos el canal se muestra caído a los administradores; cada cambio de estado queda en la
   bitácora. La web sigue siendo el canal de respaldo.

## Contrato del puente

Firma en ambos sentidos: cabeceras `X-ERP-Marca-Tiempo` (segundos Unix) y
`X-ERP-Firma: sha256=<hex HMAC-SHA256(WHATSAPP_PUENTE_SECRETO, "<marca>.<cuerpo>")>`. Se
rechazan firmas inválidas y marcas con más de 5 minutos de diferencia.

Puente → ERP:

- `POST /api/canales/whatsapp/mensajes` → 202 `{ aceptado }`
  - Texto: `{ "id": "<id del mensaje>", "de": "+56912345678", "tipo": "TEXTO", "texto": "…" }`
  - Voz: `{ "id": "…", "de": "+569…", "tipo": "AUDIO", "audio": { "base64": "…", "mime": "audio/ogg; codecs=opus" } }`
  - `"esGrupo": true` se ignora (solo chats directos).
- `POST /api/canales/whatsapp/latido` → `{ "estado": "CONECTADO" | "DESCONECTADO", "detalle": "…" }`

ERP → puente:

- `POST {WHATSAPP_PUENTE_URL}/enviar` → `{ "para": "+569…", "texto": "…" }` (textos de más de
  4.000 caracteres se envían en varias partes).

## Comandos del chat

`ayuda`, `empresas`, `empresa N`, `agentes`, `agente <nombre>`, `nueva`, `desvincular`.
Lo demás va al agente elegido (por omisión, el Gerente virtual). Una conversación se retoma
si no pasaron más de 2 horas.

## Configuración

`WHATSAPP_PUENTE_URL`, `WHATSAPP_PUENTE_SECRETO` (32+ caracteres), `WHATSAPP_NUMERO`,
`TRANSCRIPCION_URL`, `TRANSCRIPCION_MODELO`, `TRANSCRIPCION_API_KEY` (opcional).

## Pendiente

- Adaptador del conector que se usa hoy (según su tecnología) que implemente este contrato.
- Respuestas por voz (texto a voz).
- Avisar la caída del canal por correo a los administradores.
- Los límites por persona viven en memoria del proceso (ver 0008).
