# Danna AI

Agente conversacional para Slack que recopila pedidos al área de Producto y los convierte en tickets de Jira automáticamente.

## Qué hace

Danna es un bot de Slack que mantiene una conversación con el usuario para entender qué necesita, y cuando tiene toda la información, genera un borrador del ticket para que el usuario confirme antes de enviarlo a Jira.

El agente acepta tres tipos de entrada:

- **Texto**: conversación normal por chat
- **Audio**: transcribe el mensaje de voz con Whisper (OpenAI) y lo procesa como texto
- **Archivos**: analiza imágenes (PNG, JPG, GIF, WEBP) y PDFs con Claude Vision para extraer contexto relevante

Al recibir el primer mensaje de un usuario, Danna obtiene automáticamente su nombre, email y determina si es un usuario **interno** (dominio `@intiza.com`) o **externo** (cualquier otro dominio). Con eso adapta el tono de la conversación y pre-rellena los campos `requester` y `userType` del ticket sin preguntárselos al usuario.

La información que recopila para armar el ticket es:

1. Título del pedido
2. Descripción del problema o necesidad
3. Frecuencia e impacto
4. Cómo lo resuelven hoy (workaround)
5. Solución propuesta por el usuario
6. Criterio de éxito
7. Prioridad
8. Contexto adicional (opcional)

Cuando tiene todo, muestra un borrador en Slack con dos botones: **Confirmar y enviar a Jira** o **Quiero corregir algo**.

## Integraciones

| Servicio | Para qué |
|---|---|
| **Slack** | Canal principal de interacción con el usuario |
| **Claude (Anthropic)** | Motor conversacional y análisis de imágenes/PDFs |
| **Whisper (OpenAI)** | Transcripción de mensajes de audio |
| **Jira** | Creación del ticket final |

## Requisitos

- Node.js 18+
- Una Slack App en modo Socket con los siguientes scopes:
  - `chat:write`
  - `files:read`
  - `users:read`
  - `users:read.email`
- Cuenta en Anthropic con acceso a `claude-sonnet-4-20250514`
- Cuenta en OpenAI con acceso a Whisper
- Proyecto en Jira Cloud con una API token

## Configuración

Copiá `.env.example` a `.env` y completá las variables:

```bash
cp .env.example .env
```

| Variable | Descripción |
|---|---|
| `SLACK_BOT_TOKEN` | Token del bot (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Token de la app para Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Signing secret de la Slack App |
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `OPENAI_API_KEY` | API key de OpenAI |
| `JIRA_DOMAIN` | Dominio de Jira, ej: `tu-empresa.atlassian.net` |
| `JIRA_EMAIL` | Email del usuario con acceso a Jira |
| `JIRA_API_TOKEN` | API token de Jira |
| `JIRA_PROJECT_KEY` | Clave del proyecto, ej: `GDPC` |
| `JIRA_ISSUE_TYPE` | Tipo de incidencia, ej: `Tarea`, `Story`, `Bug` |

## Instalación y uso

```bash
npm install
npm start
```

Para desarrollo con recarga automática:

```bash
npm run dev
```

## Arquitectura

```
Slack (mensaje/audio/archivo)
        │
        ▼
  resolveUserProfile()       ← obtiene nombre, email y tipo (interno/externo) de Slack
        │
        ▼
  handleAudioMessage()       ← si es audio: transcribe con Whisper
  handleFileMessage()        ← si es imagen/PDF: analiza con Claude Vision
        │
        ▼
  chat()                     ← conversación con Claude usando historial de sesión
        │
        ├── respuesta parcial → postMessage en Slack
        │
        └── TICKET_READY → formatPreview() → borrador con botones en Slack
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            createJiraTicket()      continuar editando
                    │
                    ▼
              Jira Cloud
```

Las sesiones se guardan en memoria mientras el proceso está activo. Para producción se recomienda reemplazarlas por Redis u otro store persistente.
