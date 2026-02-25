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
const API_KEY = process.env.GLM_API_KEY;
const MASTER_PROMPT = process.env.MASTER_PROMPT || "";

const GLM_ENDPOINT = "https://api.us-west-2.modal.direct/v1/chat/completions";

const axiosInstance = axios.create({
  timeout: 180000
});

const SESS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR);

function sessionFile(id) {
  return path.join(SESS_DIR, `${id}.json`);
}

function loadSession(id) {
  const f = sessionFile(id);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));
  return {
    canon: [],
    active_state: "",
    turn_counter: 0,
    pending_memory: null
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

function extractYesNo(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t === "yes" || t === "y") return true;
  if (t === "no" || t === "n") return false;
  return null;
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body;
    const convoId = getConversationId(body);
    const session = loadSession(convoId);

    const lastMsg = body.messages?.slice(-1)[0]?.content || "";

    // Handle confirmation reply
    if (session.pending_memory) {
      const decision = extractYesNo(lastMsg);
      if (decision === true) {
        session.canon.push(session.pending_memory);
      }
      session.pending_memory = null;
      saveSession(convoId, session);
    }

    session.turn_counter++;

    const recent = body.messages.slice(-100);

    const memoryBlock = session.canon.length
      ? "CANON MEMORY:\n" + session.canon.map(x => "- " + x).join("\n")
      : "";

    const finalMessages = [];

    // MASTER PROMPT injection
    if (MASTER_PROMPT) {
      finalMessages.push({
        role: "system",
        content: MASTER_PROMPT
      });
    }

    // Canon memory injection
    if (memoryBlock) {
      finalMessages.push({
        role: "system",
        content: memoryBlock
      });
    }

    finalMessages.push(...recent);

    const finalBody = {
      ...body,
      messages: finalMessages,
      max_tokens: 8192,
      stream: body.stream !== false
    };

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
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let lastChunkTime = Date.now();
    let collectedText = "";

    response.data.on("data", chunk => {
      lastChunkTime = Date.now();
      const str = chunk.toString();
      collectedText += str;
      res.write(chunk);
    });

    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > 90000) {
        response.data.destroy();
        res.end();
        clearInterval(watchdog);
      }
    }, 10000);

    response.data.on("end", async () => {
      clearInterval(watchdog);

      // MEMORY DETECTION PASS every ~20 turns
      if (session.turn_counter >= 20) {
        session.turn_counter = 0;

        const detectPrompt = [
          {
            role: "system",
            content:
              "Detect if a permanent story memory occurred. Output ONE short line describing it or NONE."
          },
          {
            role: "user",
            content: collectedText.slice(-4000)
          }
        ];

        try {
          const detect = await axiosInstance.post(
            GLM_ENDPOINT,
            {
              model: "zai-org/GLM-5-FP8",
              messages: detectPrompt,
              temperature: 0.3,
              max_tokens: 200
            },
            {
              headers: {
                Authorization: `Bearer ${API_KEY}`,
                "Content-Type": "application/json"
              }
            }
          );

          const suggestion =
            detect.data.choices?.[0]?.message?.content?.trim();

          if (suggestion && suggestion !== "NONE") {
            session.pending_memory = suggestion;

            res.write(
              `data: {"choices":[{"delta":{"content":"\\n(OOC: Possible memory detected — ${suggestion}. Store permanently? Yes/No)"}}]}\n\n`
            );
          }
        } catch {}
      }

      saveSession(convoId, session);
      res.end();
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "proxy failure" });
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
