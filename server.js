const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // Increased to 50mb to safely handle 100k+ tokens

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GLM_API_KEY;
const MASTER_PROMPT = process.env.MASTER_PROMPT || "";
const GLM_ENDPOINT = "https://api.us-west-2.modal.direct/v1/chat/completions";

const axiosInstance = axios.create({
  timeout: 240000 // 4 minutes
});

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

const activeStreams = new Map();

// --- SESSION MANAGEMENT ---
function sessionFile(id) {
  return path.join(SESS_DIR, `${id}.json`);
}

function loadSession(id) {
  const f = sessionFile(id);
  if (fs.existsSync(f)) {
    return JSON.parse(fs.readFileSync(f));
  }
  return {
    structured_memory: null,
    compression_pending: false,
    hidden_message_count: 0 // Tracks how many messages have been compressed to avoid loops
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
  if (!messages || messages.length === 0) return 0;
  const text = JSON.stringify(messages);
  return Math.floor(text.length / 4);
}

// --- UPSTREAM CALLER ---
async function callModel(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axiosInstance.post(GLM_ENDPOINT, body, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        responseType: body.stream ? "stream" : "json"
      });
    } catch (err) {
      if (attempt === 1) throw err;
      console.log("Retrying upstream...");
    }
  }
}

// --- MEMORY COMPRESSION ENGINE ---
async function updateStructuredMemory(messagesToCompress, currentMemory, modelName) {
  const memoryPrompt = `
You are a professional narrative archivist. Below is a portion of a roleplay history.
Your task is to update the LONG-TERM MEMORY ledger.

CRITICAL INSTRUCTIONS:
1. PRIORITIZE: Fine details, secrets, specific likes/dislikes, and recent behavioral changes.
2. TRACK: Relationship transformations (e.g., shifts in trust, romance, or hostility).
3. RETAIN: Significant plot milestones, physical transformations, or permanent changes to the world.
4. FORMAT: Keep it as a highly structured, dense list of facts. Do not write a summary paragraph.

Current Memory Ledger:
${currentMemory || "No existing memory."}

New History to Process:
${JSON.stringify(messagesToCompress)}

Output ONLY the updated Long-Term Memory ledger.
  `;

  try {
    const response = await callModel({
      model: modelName || "glm-5",
      messages: [{ role: "system", content: memoryPrompt }],
      stream: false,
      max_tokens: 2048
    });
    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("Memory Compression Failed:", err.message);
    return currentMemory; // Fallback to old memory if it fails
  }
}

// --- MAIN PROXY ROUTE ---
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body;
  const convoId = getConversationId(body);
  const session = loadSession(convoId);

  // 1. Intercept Slash Commands (Before setting stream headers)
  const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();
  
  if (lastMsg === "/reset") {
    const f = sessionFile(convoId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return res.json({ choices: [{ message: { role: "assistant", content: "(OOC: Memory and history reset.)" } }] });
  }

  if (lastMsg === "/stats") {
    const activeMsgs = body.messages.slice(session.hidden_message_count);
    const stats = {
      session_id: convoId,
      total_messages_from_client: body.messages.length,
      hidden_compressed_messages: session.hidden_message_count,
      active_uncompressed_messages: activeMsgs.length,
      estimated_active_tokens: estimateTokens(activeMsgs),
      memory_present: !!session.structured_memory
    };
    return res.json({ choices: [{ message: { role: "assistant", content: `(OOC: Stats)\n${JSON.stringify(stats, null, 2)}` } }] });
  }

  if (lastMsg === "/memory") {
    return res.json({ choices: [{ message: { role: "assistant", content: `(OOC: Current Memory Ledger)\n${session.structured_memory || "No memory stored."}` } }] });
  }

  // 2. Stream Setup & Cleanup
  if (activeStreams.has(convoId)) {
    const oldRes = activeStreams.get(convoId);
    if (!oldRes.writableEnded) oldRes.end();
    activeStreams.delete(convoId);
  }
  activeStreams.set(convoId, res);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Janitor AI specific heartbeat (Sent to client, not localhost)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    activeStreams.delete(convoId);
  };

  res.on("close", cleanup); // If Janitor AI user closes tab or cancels

  try {
    // 3. Memory Compression Logic
    let activeMessages = body.messages.slice(session.hidden_message_count);
    let currentTokens = estimateTokens(activeMessages);

    if (currentTokens > 100000 && !session.compression_pending) {
      console.log(`[${convoId}] 100k limit reached. Compressing memory...`);
      session.compression_pending = true;
      
      // Compress everything except the last 15 messages to maintain immediate context
      const messagesToCompress = activeMessages.slice(0, -15);
      
      const newMemory = await updateStructuredMemory(messagesToCompress, session.structured_memory, body.model);
      
      session.structured_memory = newMemory;
      session.hidden_message_count += messagesToCompress.length; // Hide these from future LLM calls
      session.compression_pending = false;
      
      saveSession(convoId, session);
      
      // Update activeMessages for the current request
      activeMessages = body.messages.slice(session.hidden_message_count);
      console.log(`[${convoId}] Memory updated successfully.`);
    }

    // 4. Construct Final Prompt
    const finalMessages = [];

    if (MASTER_PROMPT) {
      finalMessages.push({ role: "system", content: MASTER_PROMPT });
      finalMessages.push({ role: "system", content: "Characters should naturally take initiative and advance scenes through actions or dialogue.\nDialogue should dominate over narration.\nEach response should move the scene forward through action, emotional shift, or tension." });
    }

    if (session.structured_memory) {
      finalMessages.push({
        role: "system",
        content: `[IMPORTANT CONTEXT: The following is a ledger of secrets, relationship changes, and world events that have occurred. You must prioritize these details over the generic history.]\n\n${session.structured_memory}`
      });
    }

    finalMessages.push(...activeMessages);

    const finalBody = {
      ...body,
      messages: finalMessages,
      stream: true,
      max_tokens: 4096
    };

    // 5. Call Upstream & Stream Response
    const upstream = await callModel(finalBody);
    let streamBuffer = "";

    upstream.data.on("data", chunk => {
      const text = chunk.toString();
      
      if (!res.writableEnded) {
        res.write(chunk);
      }

      // Robust [DONE] detection using a trailing buffer
      streamBuffer += text;
      if (streamBuffer.length > 100) streamBuffer = streamBuffer.slice(-100);
      
      if (streamBuffer.includes("[DONE]")) {
        cleanup();
        // Destroy the axios stream to prevent memory leaks
        if (upstream.data && typeof upstream.data.destroy === 'function') {
           upstream.data.destroy();
        }
      }
    });

    upstream.data.on("error", err => {
      console.error(`[${convoId}] Upstream stream error:`, err.message);
      cleanup();
    });

  } catch (err) {
    console.error(`[${convoId}] Proxy failure:`, err.message);
    if (!res.writableEnded) {
      res.write(`data: {"choices": [{"delta": {"content": "\\n\\n[System: Proxy encountered an error. Please retry.]"}}]}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    cleanup();
  }
});

// Warm ping for Render
app.get("/ping", (req, res) => res.send("alive"));

setInterval(async () => {
  try { await axios.get(`http://localhost:${PORT}/ping`); } catch {}
}, 240000);

app.listen(PORT, () => {
  console.log(`LLM Proxy v3.0 running on port ${PORT}`);
});
