const http = require("http");
const https = require("https");
const crypto = require("crypto");

const HF_BASE = "https://akhaliq-kimi-k2-7-code.hf.space";
const PORT = process.env.PORT || 3000;

function generateSessionHash() {
  return crypto.randomBytes(12).toString("base64url");
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

function streamSSE(url, res) {
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

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      hfRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          res.write(line + "\n");
        }
      });

      hfRes.on("end", () => {
        if (buffer.trim()) res.write(buffer + "\n");
        res.end();
        resolve();
      });
    });

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

const server = http.createServer(async (req, res) => {
  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };
  cors();

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", upstream: HF_BASE }));
  }

  if (req.method === "POST" && req.url === "/chat") {
    try {
      const body = await readBody(req);
      const prompt = body.prompt || "";
      const history = body.history_json || "";
      const image = body.image_b64 || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const submitRes = await fetchJSON(
        `${HF_BASE}/gradio_api/call/chat`,
        {
          method: "POST",
          body: JSON.stringify({
            data: [prompt, history, image],
          }),
        }
      );

      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Upstream rejected", detail: submitRes })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
      await streamSSE(sseUrl, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  if (req.method === "POST" && req.url === "/chat/sync") {
    try {
      const body = await readBody(req);
      const prompt = body.prompt || "";
      const history = body.history_json || "";
      const image = body.image_b64 || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const submitRes = await fetchJSON(
        `${HF_BASE}/gradio_api/call/chat`,
        {
          method: "POST",
          body: JSON.stringify({
            data: [prompt, history, image],
          }),
        }
      );

      if (!submitRes.event_id) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Upstream rejected", detail: submitRes })
        );
      }

      const sseUrl = `${HF_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
      const fullResponse = await collectSSE(sseUrl);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: fullResponse }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Not found",
      endpoints: {
        "POST /chat": "Streaming SSE proxy for /chat",
        "POST /chat/sync": "Synchronous proxy (waits for full response)",
        "GET /health": "Health check",
      },
    })
  );
});

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

      hfRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (Array.isArray(data)) fullText += data[0];
            } catch {}
          }
        }
      });

      hfRes.on("end", () => {
        resolve(fullText);
      });
    });

    req.end();
  });
}

server.listen(PORT, () => {
  console.log(`kmi2.7 proxy running on http://localhost:${PORT}`);
  console.log(`Upstream: ${HF_BASE}`);
});
