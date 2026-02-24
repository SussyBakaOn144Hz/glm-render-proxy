const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const GLM_ENDPOINT = "https://api.us-west-2.modal.direct/v1/chat/completions";
const API_KEY = process.env.GLM_API_KEY;

const axiosInstance = axios.create({
  timeout: 180000 // 3 min hard timeout
});

// ---------- memory folder ----------
const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

// ---------- ping ----------
app.get("/ping", (req, res) => {
  res.json({ status: "alive" });
});

// ---------- session id ----------
function generateSessionId(body) {
  if (body.conversation_id) return body.conversation_id;
  const first = body.messages?.[0]?.content || "default";
  return crypto.createHash("sha256").update(first).digest("hex");
}

// ---------- load/save ----------
function loadSession(sessionId) {
  const file = path.join(SESS_DIR, `${sessionId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  return { summary: "", core: [], unsummarized: 0 };
}

function saveSession(sessionId, data) {
  const file = path.join(SESS_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
}

// ---------- manual pin detection ----------
function extractPinned(messages, session) {
  for (const m of messages) {
    if (!m.content) continue;
    const txt = m.content.toLowerCase();

    if (txt.includes("remember this permanently")) {
      session.core.push(
        m.content.replace(/remember this permanently[:\-]?/i, "").trim()
      );
    }

    if (txt.includes("lock this memory")) {
      session.core.push(
        m.content.replace(/lock this memory[:\-]?/i, "").trim()
      );
    }
  }
}

// ---------- memory update ----------
async function regenerateMemory(oldSummary, coreMemory, newMessages) {
  const prompt = [
    {
      role: "system",
      content:
`You manage long-term roleplay memory.

1. Update STORY SUMMARY.
2. Extract NEW permanent facts:
   - major events
   - secrets
   - promises
   - milestones

Return JSON:
{
 "summary": "...",
 "new_core": ["..."]
}`
    },
    {
      role: "user",
      content:
`OLD SUMMARY:
${oldSummary}

CORE MEMORY:
${coreMemory.join("\n")}

NEW DIALOGUE:
${JSON.stringify(newMessages)}`
    }
  ];

  try {
    let response;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await axiosInstance.post(
          GLM_ENDPOINT,
          {
            model: "zai-org/GLM-5-FP8",
            messages: prompt,
            temperature: 0.4
          },
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }

    const text = response.data.choices?.[0]?.message?.content;
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return { summary: oldSummary, new_core: [] }; }

    return parsed;

  } catch {
    return { summary: oldSummary, new_core: [] };
  }
}

// ---------- main endpoint ----------
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body;
    if (!body.messages)
      return res.status(400).json({ error: "no messages" });

    const sessionId = generateSessionId(body);
    const session = loadSession(sessionId);

    extractPinned(body.messages, session);

    session.unsummarized += 1;

    if (session.unsummarized >= 20) {
      const memUpdate = await regenerateMemory(
        session.summary,
        session.core,
        body.messages.slice(-20)
      );

      session.summary = memUpdate.summary || session.summary;

      if (memUpdate.new_core) {
        for (const c of memUpdate.new_core) {
          if (!session.core.includes(c)) session.core.push(c);
        }
      }

      session.unsummarized = 0;
    }

    const recent = body.messages.slice(-30);

    let finalMessages = [];

    if (session.core.length) {
      finalMessages.push({
        role: "system",
        content: "CORE MEMORY:\n" + session.core.join("\n")
      });
    }

    if (session.summary) {
      finalMessages.push({
        role: "system",
        content: "STORY SUMMARY:\n" + session.summary
      });
    }

    finalMessages = finalMessages.concat(recent);

    const finalBody = { ...body, messages: finalMessages };

    saveSession(sessionId, session);

    // ---------- STREAM ----------
    if (body.stream) {

      let response;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          response = await axiosInstance({
            method: "post",
            url: GLM_ENDPOINT,
            data: finalBody,
            responseType: "stream",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json"
            }
          });
          break;
        } catch (err) {
          if (attempt === 2) throw err;
        }
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      let lastChunkTime = Date.now();

      response.data.on("data", chunk => {
        lastChunkTime = Date.now();
        res.write(chunk);
      });

      const watchdog = setInterval(() => {
        if (Date.now() - lastChunkTime > 60000) {
          response.data.destroy();
          res.end();
          clearInterval(watchdog);
        }
      }, 10000);

      response.data.on("end", () => {
        clearInterval(watchdog);
        res.end();
      });

      return;
    }

    // ---------- NORMAL ----------
    let response;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await axiosInstance.post(
          GLM_ENDPOINT,
          finalBody,
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }

    res.json(response.data);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "proxy failure" });
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
