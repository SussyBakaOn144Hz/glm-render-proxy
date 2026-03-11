const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GLM_API_KEY;
const MASTER_PROMPT = process.env.MASTER_PROMPT || "";
const GLM_ENDPOINT = "https://api.us-west-2.modal.direct/v1/chat/completions";

const axiosInstance = axios.create({ timeout: 240000 });

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

const activeStreams = new Map();

// --- HELPERS ---
function sessionFile(id) { return path.join(SESS_DIR, `${id}.json`); }

function loadSession(id) {
  const f = sessionFile(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {
    structured_memory: null,
    compression_pending: false,
    hidden_message_count: 0
  };
}

function saveSession(id, data) { fs.writeFileSync(sessionFile(id), JSON.stringify(data)); }

function getConversationId(body) {
  if (body.conversation_id) return body.conversation_id;
  const base = body.messages?.[0]?.content || "default";
  return crypto.createHash("sha256").update(base).digest("hex");
}

function estimateTokens(messages) {
  return messages ? Math.floor(JSON.stringify(messages).length / 4) : 0;
}

// --- CORE UPSTREAM ---
async function callModel(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axiosInstance.post(GLM_ENDPOINT, body, {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        responseType: body.stream ? "stream" : "json"
      });
    } catch (err) {
      if (attempt === 1) throw err;
      console.log("Retrying upstream...");
    }
  }
}

// --- MEMORY ENGINE ---
async function updateStructuredMemory(messagesToCompress, currentMemory, modelName) {
  const memoryPrompt = `Update the LONG-TERM MEMORY ledger. PRIORITIZE: Secrets, fine details, likes/dislikes, and relationship transformations. RETAIN: Significant milestones and character changes. Output ONLY a dense, structured list of facts.\n\nOld Memory: ${currentMemory || "None"}\n\nNew Data: ${JSON.stringify(messagesToCompress)}`;

  try {
    const res = await callModel({
      model: modelName || "glm-5",
      messages: [{ role: "system", content: memoryPrompt }],
      stream: false,
      max_tokens: 2048
    });
    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("Memory Update Failed:", err.message);
    return currentMemory;
  }
}

// --- MAIN ROUTE ---
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body;
  const convoId = getConversationId(body);
  const session = loadSession(convoId);

  // 1. Commands
  const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();
  if (lastMsg === "/reset") {
    if (fs.existsSync(sessionFile(convoId))) fs.unlinkSync(sessionFile(convoId));
    return res.json({ choices: [{ message: { role: "assistant", content: "(OOC: Memory reset.)" } }] });
  }

  // 2. Stream Setup
  if (activeStreams.has(convoId)) {
    try { activeStreams.get(convoId).end(); } catch {}
  }
  activeStreams.set(convoId, res);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": heartbeat\n\n"); }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    activeStreams.delete(convoId);
  };

  res.on("close", cleanup);

  try {
    // 3. Compression Trigger
    let activeMessages = body.messages.slice(session.hidden_message_count);
    if (estimateTokens(activeMessages) > 100000 && !session.compression_pending) {
      session.compression_pending = true;
      const toCompress = activeMessages.slice(0, -15);
      session.structured_memory = await updateStructuredMemory(toCompress, session.structured_memory, body.model);
      session.hidden_message_count += toCompress.length;
      session.compression_pending = false;
      saveSession(convoId, session);
      activeMessages = body.messages.slice(session.hidden_message_count);
    }

    // 4. Prompt Assembly
    const finalMessages = [];
    if (MASTER_PROMPT) {
      finalMessages.push({ role: "system", content: MASTER_PROMPT });
      finalMessages.push({ role: "system", content: "Dialogue dominates narration. Advance scenes through action/tension." });
    }
    if (session.structured_memory) {
      finalMessages.push({ role: "system", content: `[MEMORY LEDGER: Prioritize these secrets/changes]\n${session.structured_memory}` });
    }
    finalMessages.push(...activeMessages);

    // 5. Upstream Streaming with Fragment Stitching
    const upstream = await callModel({ ...body, messages: finalMessages, stream: true, max_tokens: 4096 });
    let lineBuffer = "";

    upstream.data.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      let lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // Hold onto the potentially split last line

      for (const line of lines) {
        if (!line.trim()) continue;
        if (!res.writableEnded) res.write(line + "\n");
        
        if (line.includes("data: [DONE]")) {
          cleanup();
          if (upstream.data?.destroy) upstream.data.destroy();
        }
      }
    });

    upstream.data.on("end", () => {
      if (lineBuffer.trim() && !res.writableEnded) res.write(lineBuffer + "\n\n");
      cleanup();
    });

  } catch (err) {
    console.error("Proxy Error:", err.message);
    if (!res.writableEnded) {
      res.write(`data: {"choices":[{"delta":{"content":"\\n[Proxy Error: Connection interrupted. Please retry.]"}}]}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    cleanup();
  }
});

app.get("/ping", (req, res) => res.send("alive"));
setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/ping`); } catch {} }, 240000);
app.listen(PORT, () => console.log(`Proxy v3.1 Active`));
