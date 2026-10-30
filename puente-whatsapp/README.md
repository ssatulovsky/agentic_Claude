# Puente WhatsApp (conector web, Baileys)

Conecta un número de WhatsApp (vía WhatsApp Web, librería Baileys, el conector que ya se usaba
en el prototipo) con el ERP. El ERP no habla con WhatsApp: habla con este puente mediante el
contrato firmado de `docs/decisiones/0009-canal-whatsapp.md`.

- Reenvía al ERP texto y **notas de voz** de chats directos (nunca grupos, estados ni canales).
- Recibe del ERP las respuestas (`POST /enviar`, firmado) y las envía.
- Avisa al ERP cada minuto si está conectado.
- No registra el contenido de los mensajes ni sincroniza el historial de chats.

## Modos

| Modo | Uso | Qué se reenvía al ERP | A quién puede responder |
| --- | --- | --- | --- |
| `PERSONAL` (por omisión) | Pruebas con el número de una persona | Solo el chat consigo mismo («Tú», Mensajes a ti mismo) y los números de `PUENTE_NUMEROS_PERMITIDOS` | Solo a esos mismos |
| `DEDICADO` | Número propio del ERP | Todo chat directo (el ERP decide quién está vinculado) | Cualquiera que el ERP indique |

En modo `PERSONAL` los contactos personales del titular **nunca** llegan al ERP ni reciben
respuestas. En el ERP conviene además `WHATSAPP_AVISAR_NO_VINCULADOS=false`.

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
   código de la web. Desde ahí, escriba o envíe notas de voz en ese mismo chat: responde el
   agente con sus permisos. `ayuda` muestra los comandos.

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

## Riesgos (decisión de gerencia, ver 0002)

WhatsApp Web no es la API oficial: Meta puede bloquear el número, sobre todo si envía mensajes
no solicitados, y la conexión puede caerse con cambios de WhatsApp. Si se cierra la sesión desde
el teléfono, borre `PUENTE_SESION_DIR` y vuelva a escanear el QR. La web es siempre el canal de
respaldo.
