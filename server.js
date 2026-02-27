const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GLM_API_KEY;
const MASTER_PROMPT = process.env.MASTER_PROMPT || "";

const GLM_ENDPOINT = "https://api.us-west-2.modal.direct/v1/chat/completions";

const TOKEN_THRESHOLD = 100000; // ~100k trigger
const RECENT_KEEP_RATIO = 0.35; // keep newest 35% raw

const axiosInstance = axios.create({ timeout: 240000 });

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

function sessionFile(id) {
  return path.join(SESS_DIR, `${id}.json`);
}

function loadSession(id) {
  const f = sessionFile(id);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));

  return {
    structured_memory: null,
    compression_pending: false,
    messages: []
  };
}

function saveSession(id, data) {
  fs.writeFileSync(sessionFile(id), JSON.stringify(data, null, 2));
}

function getConversationId(body) {
  if (body.conversation_id) return body.conversation_id;
  const base = body.messages?.[0]?.content || "default";
  return crypto.createHash("sha256").update(base).digest("hex");
}

function estimateTokens(messages) {
  const text = JSON.stringify(messages);
  return Math.floor(text.length / 4);
}

async function buildStructuredMemory(oldMemory, earlyMessages) {
  const prompt = [
    {
      role: "system",
      content: `
Rewrite the complete story memory in structured format.

Preserve:
- All major events chronologically
- All secrets/confessions in detail
- All preferences and traits
- Emotional shifts
- Symbolic actions
- Unresolved threads

Do not omit named events.
Do not generalize important details.

Format as:

CORE STORY EVENTS:
RELATIONSHIP PROGRESSION:
SECRETS & CONFESSIONS:
TRAITS & PREFERENCES:
SYMBOLIC MARKERS:
UNRESOLVED THREADS:
`
    },
    {
      role: "user",
      content: `
Existing Memory:
${oldMemory || "None"}

Early Conversation:
${JSON.stringify(earlyMessages)}
`
    }
  ];

  const response = await axiosInstance.post(
    GLM_ENDPOINT,
    {
      model: "zai-org/GLM-5-FP8",
      messages: prompt,
      temperature: 0.2,
      max_tokens: 12000
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.choices[0].message.content;
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body;
    const convoId = getConversationId(body);

    const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();

    if (lastMsg === "/reset") {
      const file = sessionFile(convoId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return res.json({
        choices: [{ message: { role: "assistant", content: "(OOC: Memory reset.)" } }]
      });
    }

    const session = loadSession(convoId);

    // Save full raw history
    session.messages = body.messages;

    const estimatedTokens = estimateTokens(session.messages);

    // If threshold crossed and not already pending
    if (
      estimatedTokens > TOKEN_THRESHOLD &&
      !session.compression_pending &&
      !session.structured_memory
    ) {
      session.compression_pending = true;
      saveSession(convoId, session);

      return res.json({
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "(OOC: Long-context threshold reached. Compress early arcs into structured long-term memory? Yes / No)"
            }
          }
        ]
      });
    }

    // Handle compression confirmation
    if (session.compression_pending) {
      if (lastMsg === "yes") {
        const splitIndex = Math.floor(session.messages.length * (1 - RECENT_KEEP_RATIO));
        const early = session.messages.slice(0, splitIndex);
        const recent = session.messages.slice(splitIndex);

        const newMemory = await buildStructuredMemory(
          session.structured_memory,
          early
        );

        session.structured_memory = newMemory;
        session.messages = recent;
        session.compression_pending = false;
        saveSession(convoId, session);

        return res.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "(OOC: Compression complete. Continuing RP.)"
              }
            }
          ]
        });
      }

      if (lastMsg === "no") {
        session.compression_pending = false;
        saveSession(convoId, session);
      }
    }

    // Build final prompt
    const finalMessages = [];

    if (MASTER_PROMPT) {
      finalMessages.push({ role: "system", content: MASTER_PROMPT });
    }

    if (session.structured_memory) {
      finalMessages.push({
        role: "system",
        content: "LONG-TERM MEMORY:\n" + session.structured_memory
      });
    }

    finalMessages.push(...session.messages);

    const finalBody = {
      ...body,
      messages: finalMessages,
      stream: true,
      max_tokens: 8192
    };

    const response = await axiosInstance({
      method: "post",
      url: GLM_ENDPOINT,
      data: finalBody,
      responseType: "stream",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    res.write(`data: {"choices":[{"delta":{"content":""}}]}\n\n`);

    response.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "proxy failure" });
  }
});

app.listen(PORT, () => {
  console.log("Structured Memory Engine Running");
});
