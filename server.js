const http = require("http");
const https = require("https");
const crypto = require("crypto");

const HF_BASE = "https://akhaliq-kimi-k2-7-code.hf.space";
const PORT = process.env.PORT || 3000;

function generateId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(parsed, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "kmi27-proxy/1.0",
        ...options.headers,
      },
    });

    req.on("error", reject);
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`));
        }
      });
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function messagesToPrompt(messages) {
  if (typeof messages === "string") return messages;
  if (!Array.isArray(messages)) return "";

  return messages
    .map((m) => {
      const role = m.role || "user";
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("")
          : "";
      return `[${role}]: ${content}`;
    })
    .join("\n\n");
}

function submitToHF(prompt, history, image) {
  return fetchJSON(`${HF_BASE}/gradio_api/call/chat`, {
    method: "POST",
    body: JSON.stringify({ data: [prompt, history || "", image || ""] }),
  });
}

function collectSSE(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(parsed, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "User-Agent": "kmi27-proxy/1.0",
      },
    });

    req.on("error", reject);
    req.on("response", (hfRes) => {
      let buffer = "";
      let fullText = "";
      let currentEvent = "";

      hfRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent !== "complete") {
            try {
              const data = JSON.parse(line.slice(6));
              if (Array.isArray(data)) fullText += data[0];
            } catch {}
          }
        }
      });

      hfRes.on("end", () => resolve(fullText));
    });

    req.end();
  });
}

function streamAndCollect(url, res, formatToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(parsed, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "User-Agent": "kmi27-proxy/1.0",
      },
    });

    req.on("error", reject);
    req.on("response", (hfRes) => {
      let buffer = "";
      let fullText = "";
      let currentEvent = "";

      hfRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent !== "complete") {
            try {
              const data = JSON.parse(line.slice(6));
              if (Array.isArray(data)) {
                const token = data[0];
                fullText += token;
                res.write(formatToken(token));
              }
            } catch {}
          }
        }
      });

      hfRes.on("end", () => {
        res.end();
        resolve(fullText);
      });
    });

    req.end();
  });
}

function openAIFormatToken(token) {
  const chunk = {
    id: generateId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "kimi-k2.7-code",
    choices: [
      {
        index: 0,
        delta: { content: token },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function claudeFormatToken(token) {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: token },
  })}\n\n`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        upstream: HF_BASE,
        endpoints: [
          "POST /v1/chat/completions",
          "POST /v1/messages",
          "POST /chat",
          "POST /chat/sync",
        ],
      })
    );
  }

  // Models list (some clients query this)
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "kimi-k2.7-code",
            object: "model",
            created: Date.now(),
            owned_by: "akhaliq",
          },
        ],
      })
    );
  }

  try {
    console.log(`[${req.method}] ${req.url}`);
    const body = await readBody(req);
    console.log("body:", JSON.stringify(body).slice(0, 200));

    // ─── OpenAI: POST /v1/chat/completions ───
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const prompt = messagesToPrompt(body.messages);
      const stream = body.stream !== false;

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: { message: "messages are required" } })
        );
      }

      const submitRes = await submitToHF(prompt);
      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: { message: "Upstream rejected" } })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
      const chatId = generateId();

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // send role chunk first
        const roleChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "kimi-k2.7-code",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        await streamAndCollect(sseUrl, res, openAIFormatToken);

        const stopChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "kimi-k2.7-code",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const fullText = await collectSSE(sseUrl);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: chatId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "kimi-k2.7-code",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: fullText },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          })
        );
      }
      return;
    }

    // ─── Claude: POST /v1/messages ───
    if (req.method === "POST" && req.url === "/v1/messages") {
      const prompt = messagesToPrompt(body.messages);
      const stream = body.stream === true;

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "messages required" },
          })
        );
      }

      const submitRes = await submitToHF(prompt);
      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Upstream rejected" },
          })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const msgId = "msg_" + crypto.randomBytes(16).toString("hex");

        // message_start
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: "kimi-k2.7-code",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`
        );

        // content_block_start
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`
        );

        await streamAndCollect(sseUrl, res, claudeFormatToken);

        // content_block_stop
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`
        );

        // message_delta
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`
        );

        // message_stop
        res.write(
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`
        );

        res.end();
      } else {
        const fullText = await collectSSE(sseUrl);
        const msgId = "msg_" + crypto.randomBytes(16).toString("hex");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: msgId,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: fullText }],
            model: "kimi-k2.7-code",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          })
        );
      }
      return;
    }

    // ─── Original endpoints ───
    if (req.method === "POST" && req.url === "/chat") {
      const prompt = body.prompt || "";
      const history = body.history_json || "";
      const image = body.image_b64 || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const submitRes = await submitToHF(prompt, history, image);
      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Upstream rejected", detail: submitRes })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      return streamAndCollect(sseUrl, res, (token) => `data: ${JSON.stringify([token])}\n\n`);
    }

    if (req.method === "POST" && req.url === "/chat/sync") {
      const prompt = body.prompt || "";
      const history = body.history_json || "";
      const image = body.image_b64 || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const submitRes = await submitToHF(prompt, history, image);
      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Upstream rejected", detail: submitRes })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
      const fullText = await collectSSE(sseUrl);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: fullText }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        endpoints: {
          "POST /v1/chat/completions": "OpenAI-compatible chat endpoint",
          "POST /v1/messages": "Claude-compatible messages endpoint",
          "POST /chat": "Streaming SSE proxy",
          "POST /chat/sync": "Synchronous proxy",
          "GET /v1/models": "List models",
          "GET /health": "Health check",
        },
      })
    );
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`kmi2.7 proxy running on http://localhost:${PORT}`);
  console.log(`Upstream: ${HF_BASE}`);
});
