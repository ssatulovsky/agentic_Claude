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
   90 días y se revoca si cambian el teléfono, la contraseña o el doble factor de la cuenta, o
   si se desactiva la persona. El código se guarda como HMAC con una clave derivada de la clave
   maestra (no del secreto del puente).
4. **Mismos permisos, menos autonomía.** Por WhatsApp no hay doble factor por mensaje, así que
   ninguna acción se ejecuta directamente: las de "ejecutar con aviso" quedan como propuestas
   para aprobar en la web. Consultar sí se puede.
5. **Credenciales.** Un mensaje (o nota de voz transcrita) que parece traer una clave se rechaza
   sin llegar a ningún modelo y sin guardarse, igual que en la web.
6. **Notas de voz.** Se transcriben con un servicio compatible con `/v1/audio/transcriptions`.
   Debe ser local (red privada o el propio servidor): una nota de voz puede llevar una clave
   dictada, y el filtro de credenciales solo puede revisarla después de transcribir. Un servicio
   externo exige `TRANSCRIPCION_EXTERNA_AUTORIZADA=true`; si no, el servidor no arranca. La respuesta repite lo entendido
   («Entendí: …») para que la persona lo confirme. Los audios no se guardan.
7. **Sin contenido en la tabla de mensajes.** `mensajes_whatsapp` guarda solo metadatos (para no
   procesar dos veces un mensaje y para auditar), por 30 días los de números desconocidos y un
   año el resto. El texto queda en las trazas del agente, con sus reglas de acceso.
8. **Mensajes no solicitados.** Responder en masa es lo que hace que WhatsApp bloquee un número:
   un número desconocido recibe a lo más un aviso por hora; los intentos de vinculación
   fallidos, tres respuestas por hora; y hay un tope global de 30 avisos por minuto.
9. **Entrega.** El puente recibe 202 apenas el mensaje queda registrado y el agente responde
   después. Si el servidor se reinicia a mitad (al cerrar espera hasta 20 s), el mensaje queda
   "recibido"; cuando el conector lo reenvía, pasados 15 minutos, se reprocesa (hasta 3 veces).
10. **Vigilancia de la conexión.** El puente envía un latido cada minuto. Sin latido por más de
   3 minutos el canal se muestra caído a los administradores (sin el detalle técnico del
   conector, que es de la plataforma); cada cambio de estado queda en la bitácora. La web sigue
   siendo el canal de respaldo.

## Contrato del puente

Firma en ambos sentidos: cabeceras `X-ERP-Marca-Tiempo` (segundos Unix) y
`X-ERP-Firma: sha256=<hex HMAC-SHA256(WHATSAPP_PUENTE_SECRETO, "<marca>.<MÉTODO> <ruta>.<cuerpo>")>`,
por ejemplo `1761840000.POST /api/canales/whatsapp/mensajes.{"id":…}`. La ruta fija el sentido.
Se rechazan firmas inválidas y marcas con más de 5 minutos de diferencia. Las cabeceras se
revisan antes de leer el cuerpo y la firma antes de interpretarlo; con `WHATSAPP_PUENTE_IPS`
solo se aceptan llamadas desde esas direcciones. El latido acepta cuerpos de hasta 4 KB.

Puente → ERP:

- `POST /api/canales/whatsapp/mensajes` → 202 `{ aceptado }`
  - Texto: `{ "id": "<id del mensaje>", "de": "+56912345678", "tipo": "TEXTO", "texto": "…" }`
  - Voz: `{ "id": "…", "de": "+569…", "tipo": "AUDIO", "audio": { "base64": "…", "mime": "audio/ogg; codecs=opus" } }`
  - `"esGrupo": true` se ignora (solo chats directos).
- `POST /api/canales/whatsapp/latido` → `{ "estado": "CONECTADO" | "DESCONECTADO", "detalle": "…" }`

ERP → puente:

- `POST {WHATSAPP_PUENTE_URL}/enviar` → `{ "para": "+569…", "texto": "…", "voz": "…opcional" }`, firmado con la ruta
  `POST /enviar` (textos de más de 4.000 caracteres se envían en varias partes).

## Comandos del chat

`ayuda`, `empresas`, `empresa N`, `agentes`, `agente <nombre>`, `nueva`, `desvincular`.
Lo demás va al agente elegido (por omisión, el Gerente virtual). Una conversación se retoma
si no pasaron más de 2 horas.

## Configuración

`WHATSAPP_PUENTE_URL`, `WHATSAPP_PUENTE_SECRETO` (32+ caracteres), `WHATSAPP_PUENTE_IPS`,
`WHATSAPP_NUMERO`, `TRANSCRIPCION_URL`, `TRANSCRIPCION_MODELO`, `TRANSCRIPCION_API_KEY`,
`TRANSCRIPCION_EXTERNA_AUTORIZADA`, `WHATSAPP_AVISAR_NO_VINCULADOS` (false con un número
personal de pruebas).

## Adaptador del conector existente (Baileys)

El conector que ya se usaba (prototipo, WhatsApp Web con la librería Baileys) quedó como un
proceso aparte, `puente-whatsapp/`, que implementa este contrato. Tiene un modo `PERSONAL`
para probar con el número de una persona: solo atiende el chat consigo mismo y números
permitidos, y nunca responde a sus contactos. En el chat consigo mismo solo va al ERP lo que
empieza con `erp` y lo que sigue mientras esa conversación está abierta (10 minutos), para no
enviar las notas personales del titular; lo conversado con Meta AI se descarta. Las notas de voz se descargan en el puente y se
transcriben en el ERP con Whisper local (`docker compose --profile voz`). Instrucciones en
`puente-whatsapp/README.md`.

## Respuestas con nota de voz

Cada persona elige (web o `voz siempre | auto | nunca` en el chat) si las respuestas de los
agentes llegan también como nota de voz; por omisión, cuando preguntó con voz. El texto se envía
siempre, para que las cifras queden por escrito. El ERP prepara un texto hablable (sin formato,
montos en palabras que se leen bien, a lo más ~700 caracteres) y lo manda al puente en el campo
`voz` de `/enviar`; el puente lo sintetiza con Piper y lo convierte a OGG/Opus con ffmpeg, en el
servidor, después de entregar el texto. Los comandos y avisos no van con voz.

## Pendiente

- Avisar la caída del canal por correo a los administradores.
- Los límites por persona viven en memoria del proceso (ver 0008).
