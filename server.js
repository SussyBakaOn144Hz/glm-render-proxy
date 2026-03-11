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

// --- UPSTREAM CALLER ---
async function callModel(body) {
  return await axiosInstance.post(GLM_ENDPOINT, body, {
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    responseType: body.stream ? "stream" : "json"
  });
}

// --- MEMORY ENGINE ---
async function updateStructuredMemory(messagesToCompress, currentMemory, modelName) {
  const memoryPrompt = `Update the LONG-TERM MEMORY ledger. 
  PRIORITIZE: Secrets, fine details, likes/dislikes, and relationship transformations.
  RETAIN: Significant milestones and character changes. 
  Output ONLY a dense, structured list of facts. No summaries.\n\n
  Old Memory: ${currentMemory || "None"}\n\n
  New History: ${JSON.stringify(messagesToCompress)}`;

  try {
    const res = await axiosInstance.post(GLM_ENDPOINT, {
      model: modelName || "glm-5",
      messages: [{ role: "system", content: memoryPrompt }],
      stream: false,
      max_tokens: 2048
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });
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

  // 1. Basic Commands
  const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();
  if (lastMsg === "/reset") {
    if (fs.existsSync(sessionFile(convoId))) fs.unlinkSync(sessionFile(convoId));
    return res.json({ choices: [{ message: { role: "assistant", content: "(OOC: Memory reset.)" } }] });
  }

  // 2. Clear previous stream for this convo
  if (activeStreams.has(convoId)) {
    try { activeStreams.get(convoId).end(); } catch {}
  }
  activeStreams.set(convoId, res);

  // 3. HEADERS - Crucial for Render streaming
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
    // 4. Background Memory Compression (100k Limit)
    let activeMessages = body.messages.slice(session.hidden_message_count);
    
    if (estimateTokens(activeMessages) > 100000 && !session.compression_pending) {
      session.compression_pending = true;
      const toCompress = activeMessages.slice(0, -15);
      
      // We don't 'await' here to keep the chat fast; it updates for the NEXT message
      updateStructuredMemory(toCompress, session.structured_memory, body.model).then(newMem => {
        session.structured_memory = newMem;
        session.hidden_message_count += toCompress.length;
        session.compression_pending = false;
        saveSession(convoId, session);
        console.log("Memory ledger updated in background.");
      });
    }

    // 5. Prompt Construction
    const finalMessages = [];
    if (MASTER_PROMPT) {
      finalMessages.push({ role: "system", content: MASTER_PROMPT });
      finalMessages.push({ role: "system", content: "Dialogue dominates narration. Advance scenes through action/tension." });
    }
    if (session.structured_memory) {
      finalMessages.push({ role: "system", content: `[LONG-TERM MEMORY: Secrets & Transformations]\n${session.structured_memory}` });
    }
    finalMessages.push(...activeMessages);

    // 6. THE REVAMPED PASSTHROUGH STREAM
    const upstream = await callModel({ ...body, messages: finalMessages, stream: true });

    upstream.data.on("data", (chunk) => {
      if (!res.writableEnded) {
        res.write(chunk); // Direct pipe to Janitor AI
      }
      
      if (chunk.toString().includes("[DONE]")) {
        cleanup();
        if (upstream.data?.destroy) upstream.data.destroy();
      }
    });

    upstream.data.on("end", cleanup);
    upstream.data.on("error", (e) => {
      console.error("Stream Error:", e.message);
      cleanup();
    });

  } catch (err) {
    console.error("Proxy Error:", err.message);
    cleanup();
  }
});

app.get("/ping", (req, res) => res.send("alive"));
setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/ping`); } catch {} }, 240000);
app.listen(PORT, () => console.log(`Proxy v5.0 (Passthrough) Active`));
