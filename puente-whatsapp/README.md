# Puente WhatsApp (conector web, Baileys)

Conecta un número de WhatsApp (vía WhatsApp Web, librería Baileys, el conector que ya se usaba
en el prototipo) con el ERP. El ERP no habla con WhatsApp: habla con este puente mediante el
contrato firmado de `docs/decisiones/0009-canal-whatsapp.md`.

- Reenvía al ERP texto y **notas de voz** de chats directos (nunca grupos, estados ni canales).
- Recibe del ERP las respuestas (`POST /enviar`, firmado) y las envía; si el ERP lo pide,
  también como **nota de voz** generada en el servidor con Piper (como Vera en el prototipo).
- Avisa al ERP cada minuto si está conectado.
- No registra el contenido de los mensajes ni sincroniza el historial de chats.

## Modos

| Modo | Uso | Qué se reenvía al ERP | A quién puede responder |
| --- | --- | --- | --- |
| `PERSONAL` (por omisión) | Pruebas con el número de una persona | En el chat consigo mismo («Tú»), solo lo que empieza con `erp` y lo que sigue mientras esa conversación está abierta; y los números de `PUENTE_NUMEROS_PERMITIDOS` | Solo a esos mismos |
| `DEDICADO` | Número propio del ERP | Todo chat directo (el ERP decide quién está vinculado) | Cualquiera que el ERP indique |

En modo `PERSONAL` los contactos personales del titular **nunca** llegan al ERP ni reciben
respuestas, y sus notas personales en «Tú» tampoco: solo lo que empieza con `erp`. Lo que se
conversa con Meta AI se descarta siempre. En el ERP conviene además
`WHATSAPP_AVISAR_NO_VINCULADOS=false`.

**Conversación en «Tú»:** `erp ¿cuál es el saldo del banco?` abre la conversación; durante 10
minutos desde el último mensaje, lo que escriba o las **notas de voz** que grabe van al ERP sin
repetir `erp`. `erp fin` la cierra. Solo se aceptan notas de voz grabadas (no archivos de audio
reenviados).

## Prueba con un número personal

1. **Transcripción local** (para notas de voz), una vez:
   `docker compose --profile voz up -d transcripcion`
2. **ERP** (`.env`), además de lo habitual:
   ```
   WHATSAPP_PUENTE_URL=http://127.0.0.1:3100
   WHATSAPP_PUENTE_SECRETO=<32+ caracteres al azar, p. ej. openssl rand -hex 32>
   WHATSAPP_PUENTE_IPS=127.0.0.1
   WHATSAPP_NUMERO=+569XXXXXXXX          # el número personal
   WHATSAPP_AVISAR_NO_VINCULADOS=false
   TRANSCRIPCION_URL=http://127.0.0.1:8000
   TRANSCRIPCION_MODELO=Systran/faster-whisper-small
   ```
3. **Puente**, en otra terminal del mismo servidor:
   ```
   cd puente-whatsapp && npm ci
   PUENTE_SECRETO=<el mismo secreto> ERP_URL=http://127.0.0.1:3000 npm start
   ```
   Escanee el código QR que aparece con WhatsApp > Dispositivos vinculados > Vincular un
   dispositivo. (También queda como imagen en `~/.erp-puente-whatsapp/qr.png`.)
4. **Su cuenta del ERP** debe tener ese mismo número en «Teléfono de WhatsApp» (lo registra el
   administrador). En la web, página **WhatsApp**, presione «Vincular WhatsApp».
5. En su teléfono abra el chat **«Tú» (Mensajes a ti mismo)** y envíe `VINCULAR 123456` con el
   código de la web.
6. Escriba `erp hola` (o `erp ¿cuánto IVA pago en octubre?`) y, con la conversación abierta,
   grabe una nota de voz. Responde el agente con sus permisos; a una nota de voz le antepone
   «Entendí: …» y, si Piper está instalado, también contesta con una nota de voz.
   `erp ayuda` muestra los comandos y `erp fin` cierra.

## Respuestas con nota de voz (Piper)

El texto llega siempre; la nota de voz lo acompaña según la preferencia de cada persona (web,
página WhatsApp, o en el chat `voz siempre`, `voz auto`, `voz nunca`; por omisión responde con
voz cuando se le preguntó con voz). La voz se genera en el servidor: el texto no sale a ningún
servicio externo.

1. Instalar Piper y ffmpeg (con libopus) en el servidor del puente:
   `pip install piper-tts==1.8.0` y `apt install ffmpeg`.
2. Descargar una voz (dos archivos, en la misma carpeta), por ejemplo la de Vera:
   ```
   mkdir -p ~/.erp-puente-whatsapp-voces && cd ~/.erp-puente-whatsapp-voces
   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high/es_AR-daniela-high.onnx
   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json
   ```
   Otras voces en español: `es_MX-claude-high` (masculina), `es_MX-ald-medium`.
3. Iniciar el puente con `PIPER_MODELO=~/.erp-puente-whatsapp-voces/es_AR-daniela-high.onnx`.
   `GET http://127.0.0.1:3100/salud` muestra `"voz": true`.

Si Piper falla, la respuesta igual llega por escrito.

## Variables

| Variable | Por omisión | Descripción |
| --- | --- | --- |
| `PUENTE_SECRETO` | — | Secreto HMAC compartido con el ERP (`WHATSAPP_PUENTE_SECRETO`), 32+ caracteres |
| `ERP_URL` | `http://127.0.0.1:3000` | Dirección del ERP |
| `PUENTE_MODO` | `PERSONAL` | `PERSONAL` o `DEDICADO` |
| `PUENTE_NUMEROS_PERMITIDOS` | — | Otros teléfonos (+569…) que pueden usar el puente en modo personal |
| `PUENTE_HOST` / `PUENTE_PUERTO` | `127.0.0.1` / `3100` | Dónde escucha `POST /enviar` (solo local) |
| `PUENTE_SESION_DIR` | `~/.erp-puente-whatsapp` | Sesión de WhatsApp: **es una credencial**; carpeta solo del dueño, fuera del repositorio y con respaldo cifrado |
| `PUENTE_AUDIO_MAX_BYTES` | 8 MB | Notas de voz más grandes se ignoran |
| `PUENTE_EDAD_MAXIMA_S` | 300 | Mensajes más antiguos (historial, desconexiones largas) se ignoran |
| `PUENTE_PREFIJO` | `erp` | Palabra que abre la conversación en el chat consigo mismo |
| `PUENTE_VENTANA_S` | 600 | Segundos que esa conversación queda abierta desde el último mensaje |
| `PIPER_MODELO` | — | Voz de Piper (.onnx). Sin ella no se envían notas de voz |
| `PIPER_BIN` / `FFMPEG_BIN` | `piper` / `ffmpeg` | Programas para generar y convertir la voz |

## Dependencias

Versiones fijas con `package-lock.json`. Baileys trae `libsignal` desde un commit de GitHub
(sin hash de integridad de npm): `npm ci` necesita acceso a GitHub. La versión del protocolo de
WhatsApp Web se consulta al conectar; si no responde, se usa la que trae la librería. La imagen
de transcripción (`speaches`) es una versión candidata: conviene fijarla por digest al desplegar.

## Riesgos (decisión de gerencia, ver 0002)

WhatsApp Web no es la API oficial: Meta puede bloquear el número, sobre todo si envía mensajes
no solicitados, y la conexión puede caerse con cambios de WhatsApp. Si se cierra la sesión desde
el teléfono, borre `PUENTE_SESION_DIR` y vuelva a escanear el QR. La web es siempre el canal de
respaldo.
