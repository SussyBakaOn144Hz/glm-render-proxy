const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GLM_API_KEY;
const MASTER_PROMPT = process.env.MASTER_PROMPT || "";

const HOST = "api.us-west-2.modal.direct";
const PATH_API = "/v1/chat/completions";

const TOKEN_THRESHOLD = 100000;
const RECENT_KEEP_RATIO = 0.35;

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

const activeStreams = new Map();

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
  fs.writeFileSync(sessionFile(id), JSON.stringify(data));
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

function streamToModel(payload, res, convoId) {
  const data = JSON.stringify(payload);

  const options = {
    hostname: HOST,
    path: PATH_API,
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data)
    }
  };

  const upstream = https.request(options, (response) => {

    response.on("data", (chunk) => {
      res.write(chunk);
    });

    response.on("end", () => {
      res.write("data: [DONE]\n\n");
      res.end();
      activeStreams.delete(convoId);
    });

  });

  upstream.on("error", (err) => {
    console.error("Upstream error:", err);
    res.end();
    activeStreams.delete(convoId);
  });

  upstream.write(data);
  upstream.end();
}

app.post("/v1/chat/completions", async (req, res) => {
  try {

    const body = req.body;
    const convoId = getConversationId(body);

    if (activeStreams.has(convoId)) {
      try {
        activeStreams.get(convoId).end();
      } catch {}
    }

    activeStreams.set(convoId, res);

    const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();

    if (lastMsg === "/reset") {
      const file = sessionFile(convoId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return res.json({
        choices: [{ message: { role: "assistant", content: "(OOC: Memory reset.)" } }]
      });
    }

    const session = loadSession(convoId);

    session.messages = body.messages;

    const estimatedTokens = estimateTokens(session.messages);

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
                "(OOC: Long-context threshold reached. Compress early arcs into structured memory? Yes / No)"
            }
          }
        ]
      });
    }

    if (session.compression_pending) {
      if (lastMsg === "no") {
        session.compression_pending = false;
      }
    }

    saveSession(convoId, session);

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

    const payload = {
      ...body,
      messages: finalMessages,
      stream: true,
      max_tokens: 900
    };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 3000);

    res.on("close", () => {
      clearInterval(heartbeat);
      activeStreams.delete(convoId);
    });

    streamToModel(payload, res, convoId);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "proxy failure" });
  }
});

app.get("/ping", (req, res) => {
  res.send("alive");
});

app.listen(PORT, () => {
  console.log("LLM Proxy v2.3 running");
});
