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

const axiosInstance = axios.create({
  timeout: 240000
});

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

const activeStreams = new Map();

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

app.post("/v1/chat/completions", async (req, res) => {

  try {

    const body = req.body;
    const convoId = getConversationId(body);

    if (activeStreams.has(convoId)) {
      try { activeStreams.get(convoId).end(); } catch {}
    }

    activeStreams.set(convoId, res);

    const lastMsg = body.messages?.slice(-1)[0]?.content?.trim().toLowerCase();

    const session = loadSession(convoId);

    if (lastMsg === "/reset") {

      const f = sessionFile(convoId);

      if (fs.existsSync(f)) fs.unlinkSync(f);

      return res.json({
        choices: [{ message: { role: "assistant", content: "(OOC: Memory reset.)" } }]
      });

    }

    if (lastMsg === "/stats") {

      const stats = {
        session_id: convoId,
        messages: session.messages.length,
        estimated_tokens: estimateTokens(session.messages),
        memory_present: !!session.structured_memory
      };

      return res.json({
        choices: [{
          message: {
            role: "assistant",
            content: `(OOC: Stats)\n${JSON.stringify(stats, null, 2)}`
          }
        }]
      });

    }

    if (lastMsg === "/memory") {

      return res.json({
        choices: [{
          message: {
            role: "assistant",
            content: `(OOC: Memory)\n${session.structured_memory || "No memory stored"}`
          }
        }]
      });

    }

    session.messages = body.messages;
    saveSession(convoId, session);

    const finalMessages = [];

    if (MASTER_PROMPT) {
      finalMessages.push({
        role: "system",
        content: MASTER_PROMPT
      });
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
      max_tokens: 1500
    };

    const upstream = await axiosInstance.post(
      GLM_ENDPOINT,
      finalBody,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        responseType: "stream"
      }
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    upstream.data.on("data", chunk => {
      res.write(chunk);
    });

    upstream.data.on("end", () => {
      res.end();
      activeStreams.delete(convoId);
    });

    upstream.data.on("error", err => {
      console.error(err);
      res.end();
      activeStreams.delete(convoId);
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "proxy failure"
    });

  }

});

app.get("/ping", (req, res) => {
  res.send("alive");
});

app.listen(PORT, () => {
  console.log("LLM Proxy running");
});

setInterval(async () => {

  try {
    await axios.get(`http://localhost:${PORT}/ping`);
  } catch {}

}, 240000);
