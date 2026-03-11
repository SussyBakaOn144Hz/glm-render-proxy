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
function sessionFile(id) { 
  return path.join(SESS_DIR, `${id}.json`); 
}

function loadSession(id) {
  const f = sessionFile(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {
    structured_memory: null,
    compression_pending: false,
    hidden_message_count: 0
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
  return messages && messages.length > 0 ? Math.floor(JSON.stringify(messages).length / 4) : 0;
}

// --- CORE UPSTREAM CALLER ---
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
      console.log("Retrying upstream connection...");
    }
  }
}

// --- MEMORY ENGINE ---
async function updateStructuredMemory(messagesToCompress, currentMemory, modelName) {
  const memoryPrompt = `
You are a professional narrative archivist. Update the LONG-TERM MEMORY ledger based on the provided history.
PRIORITIZE: Secrets, fine details, likes/dislikes, and relationship transformations.
RETAIN: Significant plot milestones and character changes.
FORMAT: Output ONLY a dense, structured list of facts. Do not write a summary paragraph.

Current Memory Ledger:
${currentMemory || "No existing memory."}

New History to Process:
${JSON.stringify(messagesToCompress)}
`;

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
    return currentMemory; // Keep the old memory if the update fails
  }
}

// --- MAIN ROUTE ---
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body;
  const convoId = getConversationId(body);
  const session = loadSession(convoId);

  // 1. Slash Commands
  const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();
  
  if (lastMsg === "/reset") {
    if (fs.existsSync(sessionFile(convoId))) fs.unlinkSync(sessionFile(convoId));
    return res.json({ choices: [{ message: { role: "assistant", content: "(OOC: Memory and history completely reset.)" } }] });
  }

  if (lastMsg === "/stats") {
    const activeMsgs = body.messages.slice(session.hidden_message_count);
    const stats = {
      session_id: convoId,
      total_client_messages: body.messages.length,
      hidden_compressed_messages: session.hidden_message_count,
      active_messages: activeMsgs.length,
      estimated_active_tokens: estimateTokens(activeMsgs),
      memory_present: !!session.structured_memory
    };
    return res.json({ choices: [{ message: { role: "assistant", content: `(OOC: Stats)\n${JSON.stringify(stats, null, 2)}` } }] });
  }

  if (lastMsg === "/memory") {
    return res.json({ choices: [{ message: { role: "assistant", content: `(OOC: Current Memory Ledger)\n${session.structured_memory || "No memory stored."}` } }] });
  }

  // 2. Stream Setup & Headers (Render Fixes)
  if (activeStreams.has(convoId)) {
    try { activeStreams.get(convoId).end(); } catch {}
  }
  activeStreams.set(convoId, res);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Janitor AI Heartbeat
  const heartbeat = setInterval(() => { 
    if (!res.writableEnded) res.write(": heartbeat\n\n"); 
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    activeStreams.delete(convoId);
  };

  res.on("close", cleanup);

  try {
    // 3. Compression Logic Trigger (100k Limit)
    let activeMessages = body.messages.slice(session.hidden_message_count);
    
    if (estimateTokens(activeMessages) > 100000 && !session.compression_pending) {
      console.log(`[${convoId}] 100k token limit reached. Compressing...`);
      session.compression_pending = true;
      
      const toCompress = activeMessages.slice(0, -15);
      session.structured_memory = await updateStructuredMemory(toCompress, session.structured_memory, body.model);
      session.hidden_message_count += toCompress.length;
      session.compression_pending = false;
      
      saveSession(convoId, session);
      activeMessages = body.messages.slice(session.hidden_message_count);
      console.log(`[${convoId}] Memory successfully updated.`);
    }

    // 4. Final Prompt Assembly
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

    // 5. Upstream Streaming with Safe SSE Parsing
    const upstream = await callModel(finalBody);
    let streamBuffer = "";

    upstream.data.on("data", (chunk) => {
      streamBuffer += chunk.toString();
      
      // Split strictly by double newline (the SSE standard)
      let events = streamBuffer.split("\n\n");
      
      // The last element might be an incomplete chunk, hold it in the buffer
      streamBuffer = events.pop(); 

      for (let event of events) {
        let trimmedEvent = event.trim();
        if (!trimmedEvent) continue;

        // Safely write the exact event with the required double newline
        if (!res.writableEnded) {
          res.write(trimmedEvent + "\n\n");
        }
        
        // Stop processing immediately on [DONE]
        if (trimmedEvent.includes("data: [DONE]")) {
          streamBuffer = ""; // Clear buffer to prevent double-writes
          cleanup();
          if (upstream.data && typeof upstream.data.destroy === 'function') {
            upstream.data.destroy();
          }
          return;
        }
      }
    });

    upstream.data.on("end", () => {
      // Flush any valid remaining data in the buffer
      if (streamBuffer.trim() && !res.writableEnded) {
        res.write(streamBuffer.trim() + "\n\n");
      }
      cleanup();
    });

    upstream.data.on("error", (err) => {
      console.error(`[${convoId}] Stream error:`, err.message);
      cleanup();
    });

  } catch (err) {
    console.error(`[${convoId}] Proxy Error:`, err.message);
    if (!res.writableEnded) {
      res.write(`data: {"choices":[{"delta":{"content":"\\n\\n[System: Proxy encountered an error. Please retry.]"}}]}\n\n`);
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
  console.log(`LLM Proxy v4.0 Active on port ${PORT}`);
});
