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

// ---------- memory folder ----------
const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

// ---------- keep alive ----------
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
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file));
  }
  return { summary: "", unsummarized: 0 };
}

function saveSession(sessionId, data) {
  const file = path.join(SESS_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
}

// ---------- summary engine ----------
async function regenerateSummary(oldSummary, newMessages) {
  const prompt = [
    {
      role: "system",
      content:
        "You are a long-term RP memory engine.\nRewrite structured memory.\nPreserve small details like preferences, secrets, personality, relationships.\nFormat:\nSTORY SUMMARY:\nCHARACTER MEMORY:\nRELATIONSHIP STATE:"
    },
    {
      role: "user",
      content:
        `Old summary:\n${oldSummary}\n\nNew:\n${JSON.stringify(newMessages)}`
    }
  ];

  const response = await axios.post(
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
      },
      timeout: 300000
    }
  );

  return response.data.choices?.[0]?.message?.content || oldSummary;
}

// ---------- OpenAI-compatible endpoint ----------
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body;

    if (!body.messages) {
      return res.status(400).json({ error: "no messages" });
    }

    const sessionId = generateSessionId(body);
    const session = loadSession(sessionId);

    session.unsummarized += 1;

    // every 20 turns → memory update
    if (session.unsummarized >= 20) {
      session.summary = await regenerateSummary(
        session.summary,
        body.messages.slice(-20)
      );
      session.unsummarized = 0;
    }

    const recent = body.messages.slice(-30);

    let finalMessages = [];

    if (session.summary) {
      finalMessages.push({
        role: "system",
        content: `Memory:\n${session.summary}`
      });
    }

    finalMessages = finalMessages.concat(recent);

    const response = await axios.post(
      GLM_ENDPOINT,
      {
        ...body,
        messages: finalMessages
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 300000
      }
    );

    saveSession(sessionId, session);

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "proxy failure" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
