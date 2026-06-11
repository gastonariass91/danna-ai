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

### Chequeo de duplicados (solo usuarios internos)

Antes de mostrar el borrador, Danna busca en Jira si ya existe un ticket abierto sobre el mismo problema. El proceso tiene dos etapas:

1. **Búsqueda JQL**: trae hasta 10 tickets no cerrados del proyecto que compartan palabras clave del título y la descripción del problema.
2. **Filtro semántico con Claude**: analiza los candidatos y descarta los que no son realmente el mismo problema, aunque usen palabras distintas.

Si encuentra similares, los muestra con links directos antes del borrador. El usuario puede igualmente confirmar y crear el ticket si considera que es diferente.

### Flujo post-ticket

Después de crear un ticket en Jira, Danna pregunta si el usuario necesita algo más:

- **Sí / nuevo pedido**: resetea la conversación y empieza a recopilar un nuevo ticket
- **No / despedida**: responde con un saludo y cierra la sesión

### Expiración de sesión

Las sesiones expiran tras **8 horas de inactividad**. Cuando el usuario vuelve después del TTL, el historial y el estado de conversación se limpian automáticamente, pero los datos de perfil (nombre, email, tipo) se conservan para no tener que consultarlos de nuevo. El TTL es configurable con `SESSION_TTL_HOURS`.

## Integraciones

| Servicio | Para qué |
|---|---|
| **Slack** | Canal principal de interacción con el usuario |
| **Claude (Anthropic)** | Motor conversacional, análisis de imágenes/PDFs, chequeo semántico de duplicados y detección de intención |
| **Whisper (OpenAI)** | Transcripción de mensajes de audio |
| **Jira** | Búsqueda de tickets existentes y creación del ticket final |

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

| Variable | Descripción | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | Token del bot (`xoxb-...`) | — |
| `SLACK_APP_TOKEN` | Token de la app para Socket Mode (`xapp-...`) | — |
| `SLACK_SIGNING_SECRET` | Signing secret de la Slack App | — |
| `ANTHROPIC_API_KEY` | API key de Anthropic | — |
| `OPENAI_API_KEY` | API key de OpenAI | — |
| `JIRA_DOMAIN` | Dominio de Jira, ej: `tu-empresa.atlassian.net` | — |
| `JIRA_EMAIL` | Email del usuario con acceso a Jira | — |
| `JIRA_API_TOKEN` | API token de Jira | — |
| `JIRA_PROJECT_KEY` | Clave del proyecto, ej: `GDPC` | — |
| `JIRA_ISSUE_TYPE` | Tipo de incidencia, ej: `Tarea`, `Story`, `Bug` | `Story` |
| `SESSION_TTL_HOURS` | Horas de inactividad antes de expirar la sesión | `8` |

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
  checkAndRefreshSession()   ← expira la sesión si pasaron más de SESSION_TTL_HOURS
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
        └── TICKET_READY
                │
                ▼
        postTicketPreview()
                │
          [solo internos]
                │
                ▼
    searchSimilarJiraTickets()   ← JQL: busca tickets abiertos con keywords
    filterSimilarWithClaude()    ← filtro semántico: descarta falsos positivos
                │
                ├── similares encontrados → aviso con links + borrador
                └── sin similares → borrador directo
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        createJiraTicket()      continuar editando
                │
                ▼
    "¿Necesitás algo más?"
                │
        ┌───────┴───────┐
        ▼               ▼
    GOODBYE         CONTINUE
  saludo final    nueva recolección
  cierra sesión
```

Las sesiones se guardan en memoria mientras el proceso está activo. Para producción se recomienda reemplazarlas por Redis u otro store persistente.
