require('dotenv').config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const { toFile } = require("openai");
const axios = require("axios");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (use Redis in production)
const sessions = {};

// ─── Jira ────────────────────────────────────────────────────────────────────

async function createJiraTicket(ticket) {
  const auth = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString("base64");

  const payload = {
    fields: {
      project: { key: process.env.JIRA_PROJECT_KEY },
      summary: ticket.summary,
      description: {
        type: "doc",
        version: 1,
        content: [
          paragraph(`👤 Solicitante: ${ticket.requester}`),
          ...(ticket.requesterEmail ? [paragraph(`📧 Email: ${ticket.requesterEmail}`)] : []),
          paragraph(`🏷️ Tipo: ${ticket.userType}`),
          heading("Problema"),
          paragraph(ticket.problem),
          heading("Impacto"),
          paragraph(ticket.impact),
          heading("Workaround actual"),
          paragraph(ticket.workaround),
          heading("Solución propuesta por el usuario"),
          paragraph(ticket.proposedSolution),
          heading("Criterio de éxito"),
          paragraph(ticket.successCriteria),
          ...(ticket.extraContext
            ? [heading("Contexto adicional"), paragraph(ticket.extraContext)]
            : []),
        ],
      },
      issuetype: { name: process.env.JIRA_ISSUE_TYPE || "Story" },
      priority: { name: ticket.priority },
      labels: [ticket.userType === "interno" ? "internal" : "external"],
    },
  };

  const res = await axios.post(
    `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue`,
    payload,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data;
}

async function searchSimilarJiraTickets(ticket) {
  const auth = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString("base64");

  const words = [ticket.summary, ticket.problem]
    .join(" ")
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 8)
    .map((w) => w.replace(/['"\\]/g, ""))
    .join(" ");

  const jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND statusCategory != Done AND text ~ "${words}" ORDER BY created DESC`;

  const res = await axios.get(
    `https://${process.env.JIRA_DOMAIN}/rest/api/3/search`,
    {
      headers: { Authorization: `Basic ${auth}` },
      params: { jql, maxResults: 10, fields: "summary,status" },
    }
  );

  return res.data.issues || [];
}

async function filterSimilarWithClaude(newTicket, candidates) {
  if (candidates.length === 0) return [];

  const candidateList = candidates
    .map((t, i) => `${i + 1}. [${t.key}] ${t.fields.summary}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 60,
    messages: [{
      role: "user",
      content: `Nuevo pedido:
Título: "${newTicket.summary}"
Problema: "${newTicket.problem}"

Tickets abiertos en Jira:
${candidateList}

¿Cuáles de estos tickets tratan el mismo problema o uno muy similar, aunque usen palabras distintas? Respondé solo con los números separados por coma (ej: 1,3) o NINGUNO.`,
    }],
  });

  const reply = response.content[0].text.trim().toUpperCase();
  if (reply === "NINGUNO" || reply === "") return [];

  const indices = reply
    .split(",")
    .map((n) => parseInt(n.trim()) - 1)
    .filter((n) => !isNaN(n) && n >= 0 && n < candidates.length);

  return indices.map((i) => candidates[i]);
}

function paragraph(text) {
  return {
    type: "paragraph",
    content: [{ type: "text", text: text || "—" }],
  };
}

function heading(text) {
  return {
    type: "heading",
    attrs: { level: 3 },
    content: [{ type: "text", text }],
  };
}

// ─── Claude agent ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un agente de recopilación de pedidos para el área de Producto. Tu trabajo es conversar con el usuario —puede ser interno (empleado) o externo (cliente/partner)— y obtener la información suficiente para armar un ticket de Jira claro y accionable.

INFORMACIÓN QUE NECESITÁS RECOPILAR:
1. summary: título corto del pedido (máx 80 caracteres)
2. problem: descripción del problema o necesidad real (no la solución)
3. impact: con qué frecuencia ocurre y a cuántas personas afecta
4. workaround: cómo lo resuelven hoy, si hay alguna forma alternativa
5. proposedSolution: cómo lo resolvería el usuario si pudiera
6. successCriteria: qué señal concreta indicaría que el problema está resuelto
7. priority: Highest / High / Medium / Low (preguntale con opciones simples)
8. extraContext: links, capturas, ejemplos (opcional)

REGLAS DE COMPORTAMIENTO:
- Ya sabés quién es el solicitante y su tipo (se indican al inicio del contexto). Usálos directamente en los campos "requester" y "userType" del JSON final, sin preguntárselos al usuario.
- Adaptá el tono según el tipo de usuario indicado en el contexto: con internos sé directo y técnico; con externos, más cálido y simple.
- Si una respuesta es vaga, insuficiente o contradictoria, hacé una pregunta de seguimiento antes de avanzar. No asumas.
- No hagas más de 2 preguntas a la vez.
- Cuando tengas toda la información necesaria (del 1 al 7, el 8 es opcional), respondé EXACTAMENTE con este JSON y nada más:

TICKET_READY:{"userType":"...","requester":"...","summary":"...","problem":"...","impact":"...","workaround":"...","proposedSolution":"...","successCriteria":"...","priority":"...","extraContext":"..."}

- El JSON debe estar en una sola línea, sin saltos de línea dentro.
- No agregues texto antes ni después del JSON cuando lo emitas.
- Antes de emitir el JSON, revisá internamente que cada campo tenga contenido real y útil para el equipo de Producto.`;

function buildSystemPrompt(session) {
  if (!session.userName) return SYSTEM_PROMPT;
  const emailPart = session.userEmail ? ` (${session.userEmail})` : "";
  const typePart = session.userType === "interno"
    ? " Es un empleado interno de Intiza."
    : session.userType === "externo"
    ? " Es un cliente externo."
    : "";
  const context = `El usuario que está escribiendo se llama ${session.userName}${emailPart}.${typePart}`;
  return `${context}\n\n${SYSTEM_PROMPT}`;
}

async function chat(sessionId, userMessage) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { history: [], ticket: null, userName: null, userEmail: null, userType: null };
  }

  const session = sessions[sessionId];
  session.history.push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: buildSystemPrompt(session),
    messages: session.history,
  });

  const reply = response.content[0].text;
  session.history.push({ role: "assistant", content: reply });

  // Detect if agent has all the info
  if (reply.startsWith("TICKET_READY:")) {
    const json = reply.replace("TICKET_READY:", "").trim();
    session.ticket = JSON.parse(json);
    session.ticket.requesterEmail = session.userEmail;
    if (session.userType) session.ticket.userType = session.userType;
    return { type: "ready", ticket: session.ticket };
  }

  return { type: "message", text: reply };
}

// ─── Format ticket preview for Slack ─────────────────────────────────────────

function formatPreview(ticket) {
  const priorityEmoji = {
    Highest: "🔴",
    High: "🟠",
    Medium: "🟡",
    Low: "🟢",
  };

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Borrador del ticket", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${ticket.summary}*\n${priorityEmoji[ticket.priority] || "⚪"} Prioridad: ${ticket.priority} · 👤 ${ticket.requester} · 🏷️ ${ticket.userType === "interno" ? "Interno" : "Externo"}`,
      },
    },
    { type: "divider" },
    field("🔍 Problema", ticket.problem),
    field("📊 Impacto", ticket.impact),
    field("🔧 Workaround actual", ticket.workaround),
    field("💡 Solución propuesta", ticket.proposedSolution),
    field("✅ Criterio de éxito", ticket.successCriteria),
    ...(ticket.extraContext
      ? [field("📎 Contexto adicional", ticket.extraContext)]
      : []),
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Confirmar y enviar a Jira", emoji: true },
          style: "primary",
          action_id: "confirm_ticket",
          value: "confirm",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✏️ Quiero corregir algo", emoji: true },
          action_id: "edit_ticket",
          value: "edit",
        },
      ],
    },
  ];
}

function field(label, value) {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*${label}*\n${value || "—"}` },
  };
}

// ─── User profile resolution ─────────────────────────────────────────────────

async function resolveUserProfile(userId, client) {
  if (!sessions[userId]) {
    sessions[userId] = { history: [], ticket: null, userName: null, userEmail: null, userType: null };
  }
  const session = sessions[userId];
  if (session.userName) return;

  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user?.profile || {};
    session.userName = profile.real_name
      || (profile.first_name ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") : null)
      || profile.display_name
      || null;
    session.userEmail = profile.email || null;
    session.userType = session.userEmail
      ? (session.userEmail.endsWith("@intiza.com") ? "interno" : "externo")
      : null;
  } catch (err) {
    console.error("Could not resolve Slack user profile:", err?.message);
  }
}

// ─── File handling ────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

async function downloadFile(url) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
}

async function transcribeAudio(buffer, filename, mimetype) {
  const file = await toFile(buffer, filename || "audio.mp4", {
    type: mimetype || "audio/mp4",
  });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

  return transcription.text;
}

async function analyzeFileWithClaude(buffer, mimetype) {
  const base64Data = buffer.toString("base64");

  if (SUPPORTED_IMAGE_TYPES.includes(mimetype)) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimetype, data: base64Data },
            },
            {
              type: "text",
              text: "Analizá esta imagen en el contexto de un pedido de producto para el equipo de Producto. Describí qué muestra, qué problema o necesidad se puede ver, y qué información es relevante para armar un ticket de Jira.",
            },
          ],
        },
      ],
    });
    return { supported: true, kind: "imagen", description: response.content[0].text };
  }

  if (mimetype === "application/pdf") {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64Data },
            },
            {
              type: "text",
              text: "Analizá este documento en el contexto de un pedido de producto para el equipo de Producto. Extraé la información relevante para armar un ticket de Jira: problema o necesidad, impacto, solución propuesta, criterios de éxito, y cualquier otro detalle útil.",
            },
          ],
        },
      ],
    });
    return { supported: true, kind: "PDF", description: response.content[0].text };
  }

  return { supported: false };
}

async function handleAudioMessage(event, client, audioFile) {
  const sessionId = event.user;

  await client.chat.postMessage({
    channel: event.channel,
    text: "Escuché tu audio, transcribiéndolo...",
  });

  try {
    const buffer = await downloadFile(
      audioFile.url_private_download || audioFile.url_private
    );
    const transcribedText = await transcribeAudio(buffer, audioFile.name, audioFile.mimetype);
    const result = await chat(sessionId, transcribedText);

    const transcriptHeader = `🎤 Escuché tu audio. Transcripción:\n> _"${transcribedText}"_\n\n`;

    if (result.type === "message") {
      await client.chat.postMessage({
        channel: event.channel,
        text: transcriptHeader + result.text,
      });
    } else if (result.type === "ready") {
      await client.chat.postMessage({ channel: event.channel, text: transcriptHeader.trim() });
      await postTicketPreview(event.channel, result.ticket, client);
    }
  } catch (err) {
    console.error("Audio processing error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "Hubo un error procesando el audio. Por favor intentá escribir tu mensaje.",
    });
  }
}

async function handleFileMessage(event, client, sharedFile) {
  const sessionId = event.user;

  await client.chat.postMessage({
    channel: event.channel,
    text: "Recibí tu archivo, lo estoy analizando...",
  });

  try {
    const buffer = await downloadFile(
      sharedFile.url_private_download || sharedFile.url_private
    );
    const analysis = await analyzeFileWithClaude(buffer, sharedFile.mimetype);

    if (!analysis.supported) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `El formato *${sharedFile.mimetype || "desconocido"}* no está soportado. Por favor enviá una imagen (PNG, JPG, GIF, WEBP) o un PDF.`,
      });
      return;
    }

    const contextMessage = `El usuario adjuntó un archivo (${analysis.kind}: "${sharedFile.name || "sin nombre"}"). Contenido analizado:\n\n${analysis.description}`;
    const result = await chat(sessionId, contextMessage);

    if (result.type === "message") {
      await client.chat.postMessage({
        channel: event.channel,
        text: result.text,
      });
    } else if (result.type === "ready") {
      await postTicketPreview(event.channel, result.ticket, client);
    }
  } catch (err) {
    console.error("File processing error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "Hubo un error procesando el archivo. Por favor intentá de nuevo o escribí tu mensaje.",
    });
  }
}

// ─── Ticket preview with duplicate check ─────────────────────────────────────

async function postTicketPreview(channel, ticket, client) {
  if (ticket.userType === "interno") {
    try {
      const candidates = await searchSimilarJiraTickets(ticket);
      const similar = await filterSimilarWithClaude(ticket, candidates);
      if (similar.length > 0) {
        const domain = process.env.JIRA_DOMAIN;
        const links = similar
          .map((t) => `• <https://${domain}/browse/${t.key}|${t.key}> — ${t.fields.summary} _(${t.fields.status.name})_`)
          .join("\n");
        await client.chat.postMessage({
          channel,
          text: `⚠️ Antes de continuar, encontré ${similar.length === 1 ? "un ticket" : "algunos tickets"} que podrían ser similares al tuyo:\n${links}\n\nIgualmente te muestro el borrador por si querés continuar:`,
        });
      }
    } catch (err) {
      console.error("Jira duplicate check error:", err?.message);
    }
  }

  await client.chat.postMessage({
    channel,
    text: "Listo, tengo todo lo que necesito. Revisá el borrador antes de que lo mande:",
    blocks: formatPreview(ticket),
  });
}

// ─── Follow-up after ticket ───────────────────────────────────────────────────

async function detectFollowUpIntent(message) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: `El usuario respondió: "${message}". ¿Está diciendo que no necesita nada más / se despide, o tiene otro pedido? Respondé solo: GOODBYE o CONTINUE`,
    }],
  });
  return response.content[0].text.trim().startsWith("GOODBYE") ? "goodbye" : "continue";
}

async function handleFollowUpMessage(event, client, text) {
  const sessionId = event.user;
  const session = sessions[sessionId];

  try {
    const intent = await detectFollowUpIntent(text);

    if (intent === "goodbye") {
      const firstName = session?.userName?.split(" ")[0] || "";
      delete sessions[sessionId];
      await client.chat.postMessage({
        channel: event.channel,
        text: `¡Perfecto${firstName ? `, ${firstName}` : ""}! Fue un placer ayudarte. Que tengas una excelente jornada 👋`,
      });
      return;
    }

    // User has another request — clear flag and continue normally
    session.awaitingFollowUp = false;
    const result = await chat(sessionId, text);

    if (result.type === "message") {
      await client.chat.postMessage({ channel: event.channel, text: result.text });
    } else if (result.type === "ready") {
      await postTicketPreview(event.channel, result.ticket, client);
    }
  } catch (err) {
    console.error("Follow-up error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "Hubo un error. Por favor intentá de nuevo.",
    });
  }
}

// ─── Slack event handlers ─────────────────────────────────────────────────────

// DM or mention handler
app.event("message", async ({ event, client }) => {
  // Ignore bot messages
  if (event.bot_id) return;

  await resolveUserProfile(event.user, client);

  // Handle file shares (audio, image, PDF, other)
  if (event.subtype === "file_share" && event.files?.length > 0) {
    const file = event.files[0];
    if (file.mimetype?.startsWith("audio/")) {
      await handleAudioMessage(event, client, file);
    } else {
      await handleFileMessage(event, client, file);
    }
    return;
  }

  // Ignore other subtypes (edited messages, etc.)
  if (event.subtype) return;

  const sessionId = event.user;
  const text = event.text?.trim();
  if (!text) return;

  if (sessions[sessionId]?.awaitingFollowUp) {
    await handleFollowUpMessage(event, client, text);
    return;
  }

  try {
    const result = await chat(sessionId, text);

    if (result.type === "message") {
      await client.chat.postMessage({
        channel: event.channel,
        text: result.text,
      });
    } else if (result.type === "ready") {
      await postTicketPreview(event.channel, result.ticket, client);
    }
  } catch (err) {
    console.error("Agent error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "Hubo un error procesando tu mensaje. Por favor intentá de nuevo.",
    });
  }
});

// Confirm button → create Jira ticket
app.action("confirm_ticket", async ({ body, ack, client }) => {
  await ack();

  const sessionId = body.user.id;
  const session = sessions[sessionId];

  if (!session?.ticket) {
    await client.chat.postMessage({
      channel: body.channel.id,
      text: "No encontré el ticket en sesión. Por favor volvé a iniciar el pedido.",
    });
    return;
  }

  try {
    const jiraIssue = await createJiraTicket(session.ticket);
    const jiraUrl = `https://${process.env.JIRA_DOMAIN}/browse/${jiraIssue.key}`;

    // Update the message removing the buttons
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Ticket creado exitosamente*\n*<${jiraUrl}|${jiraIssue.key} — ${session.ticket.summary}>*\nEl equipo de Producto ya puede verlo.`,
          },
        },
      ],
      text: `Ticket ${jiraIssue.key} creado en Jira.`,
    });

    // Reset conversation but keep profile for potential follow-up
    session.history = [];
    session.ticket = null;
    session.awaitingFollowUp = true;

    await client.chat.postMessage({
      channel: body.channel.id,
      text: "¿Necesitás que te ayude con algo más?",
    });
  } catch (err) {
    const jiraErrors = err.response?.data?.errors;
    const jiraMessages = err.response?.data?.errorMessages;
    const detail = jiraErrors
      ? Object.entries(jiraErrors).map(([k, v]) => `• ${k}: ${v}`).join("\n")
      : jiraMessages?.length
      ? jiraMessages.join("\n")
      : err.message;
    console.error("Jira error:", err.response?.data || err.message);
    await client.chat.postMessage({
      channel: body.channel.id,
      text: `❌ Error al crear el ticket en Jira:\n\`\`\`${detail}\`\`\``,
    });
  }
});

// Edit button → resume conversation
app.action("edit_ticket", async ({ body, ack, client }) => {
  await ack();

  const sessionId = body.user.id;
  const session = sessions[sessionId];

  // Remove ticket from session so agent can keep collecting
  if (session) session.ticket = null;

  await client.chat.postMessage({
    channel: body.channel.id,
    text: "Perfecto, contame qué querés cambiar o agregar.",
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log("⚡ Product Agent corriendo en Slack");
})();
