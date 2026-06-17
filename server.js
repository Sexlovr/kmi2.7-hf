const http = require("http");
const https = require("https");
const crypto = require("crypto");

const KIMI_BASE = "https://akhaliq-kimi-k2-7-code.hf.space";
const MINIMAX_BASE = "https://akhaliq-minimax-m3.hf.space";
const GLM_BASE = "https://lujin-zai-org-glm-5-1.hf.space";
const GLM52_BASE = "https://akhaliq-glm-5-2.hf.space";
const PORT = process.env.PORT || 3000;

const UPSTREAMS = {
  kimi: { base: KIMI_BASE, name: "kimi-k2.7-code", context: 131072 },
  minimax: { base: MINIMAX_BASE, name: "minimax-m3", context: 1000000 },
  glm: { base: GLM_BASE, name: "glm-5.1", context: 128000 },
  "glm-5.2": { base: GLM52_BASE, name: "glm-5.2", context: 128000 },
  "glm-5.2-code": { base: GLM52_BASE, name: "glm-5.2-code", context: 128000 },
};

const TERMINAL_SYSTEM_PROMPT = "You are a senior system administrator and Unix terminal helper. Answer requests using command-line commands, scripts, code configurations, and wrap instructions in monospaced outputs.";

function resolveUpstream(model) {
  if (!model) return UPSTREAMS.kimi;
  const m = model.toLowerCase();
  if (m.includes("minimax")) return UPSTREAMS.minimax;
  if (m === "glm-5.2" || m === "glm-5.2-code") return UPSTREAMS[m];
  if (m.includes("glm")) return UPSTREAMS.glm;
  return UPSTREAMS.kimi;
}

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

function buildToolPrompt(tools) {
  if (!tools || tools.length === 0) return "";
  const toolDesc = tools
    .map((t) => {
      const fn = t.function || t;
      const params = fn.parameters?.properties
        ? Object.entries(fn.parameters.properties)
            .map(([k, v]) => `    - ${k} (${v.type}${v.description ? ": " + v.description : ""})${fn.parameters.required?.includes(k) ? " [required]" : ""}`)
            .join("\n")
        : "    (no parameters)";
      return `  - ${fn.name}: ${fn.description || ""}\n${params}`;
    })
    .join("\n\n");

  return `\n\n[SYSTEM INSTRUCTION - TOOL CALLING MODE]\nYou have access to the following tools:\n${toolDesc}\n\nWhen you need to call a tool, you MUST output EXACTLY this JSON format and nothing else:\n{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"TOOL_NAME","arguments":"{\\"param\\":\\"value\\"}"}}]}\n\nDo NOT wrap in markdown. Do NOT add explanation. Output ONLY the raw JSON object when calling a tool. If you don't need a tool, respond normally.`;
}

function injectToolPrompt(messages, tools) {
  if (!tools || tools.length === 0) return messages;
  const toolList = tools
    .map((t) => {
      const fn = t.function || t;
      return `- ${fn.name}: ${fn.description || "no description"}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`;
    })
    .join("\n");
  const toolSystem = `[SYSTEM]: You have access to the following tools:\n${toolList}\n\nWhen you need to call a tool, you MUST respond with ONLY a JSON object in this exact format (no markdown, no explanation):\n{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"TOOL_NAME","arguments":"{\\"param\\":\\"value\\"}"}}]}\nThe "arguments" field must be a JSON string (escaped). Do NOT use markdown code blocks. Do NOT add any text before or after the JSON.`;
  const msgs = [...messages];
  const sysIdx = msgs.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    msgs[sysIdx] = { ...msgs[sysIdx], content: msgs[sysIdx].content + "\n\n" + toolSystem };
  } else {
    msgs.unshift({ role: "system", content: toolSystem });
  }
  return msgs;
}

function submitToHF(prompt, history, image) {
  return fetchJSON(`${KIMI_BASE}/gradio_api/call/chat`, {
    method: "POST",
    body: JSON.stringify({ data: [prompt, history || "", image || ""] }),
  });
}

function submitToMiniMax(messages) {
  return fetchJSON(`${MINIMAX_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36",
    },
    body: JSON.stringify({ messages }),
  });
}

function streamMiniMax(messages, res, formatToken, modelName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages });
    const parsed = new URL(`${MINIMAX_BASE}/chat`);
    const req = https.request(parsed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36",
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
              if (data.token) {
                fullText += data.token;
                res.write(formatToken(data.token));
              }
            } catch {}
          }
        }
      });

      hfRes.on("end", () => resolve(fullText));
    });

    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════
//  GLM-5.1 API (Gradio 6.x Queue-based)
// ══════════════════════════════════════════

function glmFetch(url, body, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqBody = body ? JSON.stringify(body) : null;
    const opts = {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "x-gradio-server": GLM_BASE + "/",
        "x-gradio-user": "app",
        ...(body ? {} : { Accept: "text/event-stream" }),
      },
      timeout: timeout || 120000,
    };
    const req = https.request(parsed, opts);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

function glmCollectSSE(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(parsed, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "x-gradio-server": GLM_BASE + "/",
      },
      timeout: timeout || 180000,
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.on("response", (res) => {
      let buffer = "";
      let lastResult = null;
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.msg === "process_completed" && data.output) {
                lastResult = data;
              }
            } catch {}
          }
        }
      });
      res.on("end", () => resolve(lastResult));
    });
    req.end();
  });
}

async function glmChat(userMessage) {
  const session = "glm_" + crypto.randomBytes(8).toString("hex");

  // Start heartbeat
  const hbUrl = `${GLM_BASE}/gradio_api/heartbeat/${session}`;
  const hbParsed = new URL(hbUrl);
  const hbReq = https.request(hbParsed, {
    method: "GET",
    headers: { Accept: "text/event-stream", "x-gradio-server": GLM_BASE + "/" },
    timeout: 180000,
  });
  hbReq.on("error", () => {});
  hbReq.on("response", (res) => { res.on("data", () => {}); });
  hbReq.end();

  const predict = (fnIndex, data) =>
    glmFetch(`${GLM_BASE}/gradio_api/run/predict?__theme=system`, {
      data,
      event_data: null,
      fn_index: fnIndex,
      trigger_id: 10,
      session_hash: session,
    });

  // GLM only takes a single message string, not multi-turn.
  // The userMessage is already flattened by the caller.

  // Step 1: Save textbox
  await predict(0, [userMessage]);

  // Step 2: Append to history
  await predict(14, []);

  // Step 3: Save conversation
  await predict(1, [null, []]);

  // Step 4: Queue join (the actual LLM call)
  const joinRes = await glmFetch(`${GLM_BASE}/gradio_api/queue/join?__theme=system`, {
    data: [null, null],
    event_data: null,
    fn_index: 2,
    trigger_id: 10,
    session_hash: session,
  });

  if (!joinRes || !joinRes.event_id) {
    throw new Error("GLM queue/join failed");
  }

  // Step 5: Listen on queue/data for response
  const sseUrl = `${GLM_BASE}/gradio_api/queue/data?session_hash=${session}`;
  const result = await glmCollectSSE(sseUrl, 180000);

  // Step 6: Extract response
  if (result && result.output && result.output.data) {
    const convHistory = result.output.data[1];
    if (convHistory && convHistory.length > 1) {
      const assistantMsg = convHistory[convHistory.length - 1];
      if (assistantMsg.role === "assistant" && assistantMsg.content && assistantMsg.content[0]) {
        const text = assistantMsg.content[0].text;
        await predict(3, [null, convHistory]).catch(() => {});
        await predict(5, [null, null, []]).catch(() => {});
        return text;
      }
    }
  }

  throw new Error("GLM: no response in output");
}

// ══════════════════════════════════════════
//  GLM-5.2 API (OpenAI-compatible /api/chat)
// ══════════════════════════════════════════

function glm52Chat(messages, stream, modelName) {
  const isCode = modelName && modelName.includes("code");
  const msgs = isCode
    ? [{ role: "system", content: TERMINAL_SYSTEM_PROMPT }, ...messages.filter(m => m.role !== "system")]
    : messages;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      messages: msgs,
      model: "zai-org/GLM-5.2:fireworks-ai",
      temperature: 0.7,
      stream: !!stream,
    });
    const parsed = new URL(`${GLM52_BASE}/api/chat`);
    const req = https.request(parsed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": GLM52_BASE,
        "User-Agent": "Mozilla/5.0",
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      timeout: 120000,
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.on("response", (res) => {
      if (stream) {
        resolve(res);
      } else {
        let buf = "";
        res.on("data", (c) => buf += c.toString());
        res.on("end", () => {
          // Non-streaming: collect all data: lines
          let full = "";
          for (const line of buf.split("\n")) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try { full += JSON.parse(line.slice(6)).content || ""; } catch {}
            }
          }
          resolve(full);
        });
      }
    });
    req.write(body);
    req.end();
  });
}

function streamGLM52(resStream, res, formatToken) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let fullText = "";

    resStream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) {
              fullText += data.content;
              res.write(formatToken(data.content));
            }
          } catch {}
        }
      }
    });

    resStream.on("end", () => resolve(fullText));
    resStream.on("error", reject);
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

// ══════════════════════════════════════════
//  Tool Call Converter
//  Kimi outputs tool calls in various formats inside content.
//  This converts them to proper OpenAI tool_calls format.
// ══════════════════════════════════════════

// Known tool names that map to code block languages
const CODE_LANG_TO_TOOL = {
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
  python: "python", python3: "python", py: "python",
  javascript: "execute_code", js: "execute_code", node: "execute_code",
  typescript: "execute_code", ts: "execute_code",
  ruby: "execute_code", rb: "execute_code",
  go: "execute_code", rust: "execute_code", c: "execute_code", cpp: "execute_code",
  java: "execute_code", php: "execute_code", lua: "execute_code",
  powershell: "execute_code", pwsh: "execute_code",
};

function parseXmlToolCalls(text) {
  var calls = [];
  var re1 = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
  var m;
  while ((m = re1.exec(text)) !== null) {
    var fn = m[1], inner = m[2], params = {};
    var re2 = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi, p;
    while ((p = re2.exec(inner)) !== null) { params[p[1]] = p[2].trim(); }
    var args = params.command ? JSON.stringify({command:params.command}) : Object.keys(params).length > 0 ? JSON.stringify(params) : "{}";
    calls.push({id:"call_"+crypto.randomBytes(8).toString("hex"),type:"function",function:{name:fn,arguments:args}});
  }
  if (calls.length > 0) return calls;
  var re3 = /<function_call\s+name=["']([^"']+)["']>([\s\S]*?)<\/function_call>/gi;
  while ((m = re3.exec(text)) !== null) {
    calls.push({id:"call_"+crypto.randomBytes(8).toString("hex"),type:"function",function:{name:m[1],arguments:m[2].trim()||"{}"}});
  }
  return calls.length > 0 ? calls : null;
}

function tryParseToolCalls(text, availableTools) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  // 1. Direct JSON object with tool_calls
  if (trimmed.startsWith('{"tool_calls"') || trimmed.startsWith('{"tool_calls":')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.tool_calls) return normalizeToolCalls(obj.tool_calls);
    } catch {}
  }

  // 2. JSON embedded in text: extract the first { ... } block with tool_calls
  const tcStart = trimmed.indexOf('{"tool_calls"');
  if (tcStart > 0) {
    let depth = 0;
    for (let i = tcStart; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(trimmed.slice(tcStart, i + 1));
            if (obj.tool_calls) return normalizeToolCalls(obj.tool_calls);
          } catch {}
          break;
        }
      }
    }
  }

  // 3. XML tool calls
  const xmlCalls = parseXmlToolCalls(text);
  if (xmlCalls) return xmlCalls;

  // 4. Markdown code blocks — convert to tool calls if tools were provided
  if (availableTools && availableTools.length > 0) {
    const toolNames = new Set(availableTools.map(t => t.function?.name || t.name || ""));
    const codeBlockRe = /```(\w+)?\s*\n([\s\S]*?)```/g;
    let match;
    const calls = [];
    while ((match = codeBlockRe.exec(trimmed)) !== null) {
      const lang = (match[1] || "").toLowerCase();
      const code = match[2].trim();
      if (!code) continue;

      // Try to match language to a tool name
      let toolName = CODE_LANG_TO_TOOL[lang];
      if (toolName && toolNames.has(toolName)) {
        calls.push({
          id: "call_" + crypto.randomBytes(8).toString("hex"),
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify({ command: code }),
          },
        });
      } else if (lang === "json" || lang === "") {
        // Try to parse JSON inside code block
        try {
          const obj = JSON.parse(code);
          if (obj.tool_calls) return normalizeToolCalls(obj.tool_calls);
          if (obj.function_call) {
            return [{
              id: "call_" + crypto.randomBytes(8).toString("hex"),
              type: "function",
              function: {
                name: obj.function_call.name || "unknown",
                arguments: typeof obj.function_call.arguments === "string"
                  ? obj.function_call.arguments
                  : JSON.stringify(obj.function_call.arguments || {}),
              },
            }];
          }
          if (obj.tool && obj.arguments) {
            if (toolNames.has(obj.tool)) {
              calls.push({
                id: "call_" + crypto.randomBytes(8).toString("hex"),
                type: "function",
                function: {
                  name: obj.tool,
                  arguments: typeof obj.arguments === "string"
                    ? obj.arguments
                    : JSON.stringify(obj.arguments),
                },
              });
            }
          }
        } catch {}
      }
    }
    if (calls.length > 0) return calls;
  }

  return null;
}

function normalizeToolCalls(tc) {
  // Already an array of proper tool_calls
  if (Array.isArray(tc)) {
    return tc.map((t, i) => ({
      id: t.id || `call_${crypto.randomBytes(8).toString("hex")}`,
      type: "function",
      function: {
        name: t.function?.name || t.name || "unknown",
        arguments: typeof t.function?.arguments === "string"
          ? t.function.arguments
          : typeof t.arguments === "string"
          ? t.arguments
          : JSON.stringify(t.function?.arguments || t.arguments || {}),
      },
    }));
  }

  // Single tool_call object: {"type":"function","function":{"name":"...","arguments":"..."}}
  if (tc.type === "function" && tc.function) {
    return [{
      id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
      type: "function",
      function: {
        name: tc.function.name || "unknown",
        arguments: typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {}),
      },
    }];
  }

  // {"tool_calls": {"type":"function","function":{...}}} (the case the user showed)
  if (tc.type === "function" && tc.function) {
    return [{
      id: `call_${crypto.randomBytes(8).toString("hex")}`,
      type: "function",
      function: {
        name: tc.function.name || "unknown",
        arguments: typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {}),
      },
    }];
  }

  // Unknown format, try to salvage
  return null;
}

function openAIFormatToken(token, modelName) {
  const chunk = {
    id: generateId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || "kimi-k2.7-code",
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");

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
        upstreams: {
          kimi: KIMI_BASE,
          minimax: MINIMAX_BASE,
          glm: GLM_BASE,
        },
        endpoints: [
          "POST /v1/chat/completions",
          "POST /v1/messages",
          "POST /chat",
          "POST /chat/sync",
        ],
        routing:
          "model containing 'minimax' → MiniMax, 'glm' → GLM-5.1, otherwise → Kimi",
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
          {
            id: "minimax-m3",
            object: "model",
            created: Date.now(),
            owned_by: "akhaliq",
          },
          {
            id: "glm-5.1",
            object: "model",
            created: Date.now(),
            owned_by: "lujin",
          },
          {
            id: "glm-5.2",
            object: "model",
            created: Date.now(),
            owned_by: "akhaliq",
          },
          {
            id: "glm-5.2-code",
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
      const upstream = resolveUpstream(body.model);
      const stream = body.stream !== false;
      const chatId = generateId();

      // For MiniMax, send messages array directly
      // For Kimi, flatten to prompt string
      const isMiniMax = upstream === UPSTREAMS.minimax;
      const isGlm = upstream === UPSTREAMS.glm;
      const isGlm52 = upstream === UPSTREAMS["glm-5.2"] || upstream === UPSTREAMS["glm-5.2-code"];
      const hasTools = !isMiniMax && body.tools && body.tools.length > 0;
      const kimiMessages = hasTools ? injectToolPrompt(body.messages || [], body.tools) : body.messages || [];
      const messages = kimiMessages;
      const prompt = isMiniMax ? "" : messagesToPrompt(kimiMessages);

      if (!isMiniMax && !isGlm && !isGlm52 && !prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: { message: "messages are required" } })
        );
      }

      if (isGlm52) {
        // GLM-5.2 — OpenAI-compatible /api/chat
        try {
          if (stream) {
            const resStream = await glm52Chat(body.messages || [], true, body.model);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            const roleChunk = {
              id: chatId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
            const fullText = await streamGLM52(resStream, res, (t) => openAIFormatToken(t, upstream.name));
            res.write(`data: ${JSON.stringify({
              id: chatId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            const fullText = await glm52Chat(body.messages || [], false, body.model);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              id: chatId, object: "chat.completion",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }));
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "GLM-5.2 error: " + err.message } }));
          }
        }
        return;
      }

      if (isGlm) {
        // GLM only accepts a single message — flatten entire conversation
        const glmMsg = messagesToPrompt(body.messages || []);

        try {
          const fullText = await glmChat(glmMsg);

          if (stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            const roleChunk = {
              id: chatId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

            // Emit in chunks for streaming effect
            const chunkSize = 20;
            for (let i = 0; i < fullText.length; i += chunkSize) {
              res.write(openAIFormatToken(fullText.slice(i, i + chunkSize), upstream.name));
            }

            res.write(`data: ${JSON.stringify({
              id: chatId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              id: chatId, object: "chat.completion",
              created: Math.floor(Date.now() / 1000), model: upstream.name,
              choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }));
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "GLM upstream error: " + err.message } }));
          }
        }
        return;
      }

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const roleChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: upstream.name,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        if (isMiniMax) {
          await streamMiniMax(
            messages,
            res,
            (t) => openAIFormatToken(t, upstream.name),
            upstream.name
          );
        } else {
          const submitRes = await submitToHF(prompt);
          if (!submitRes.event_id) {
            res.writeHead(502, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({ error: { message: "Upstream rejected" } })
            );
          }
          const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
          await streamAndCollect(
            sseUrl,
            res,
            (t) => openAIFormatToken(t, upstream.name)
          );
        }

        const stopChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: upstream.name,
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
        // Non-streaming
        let fullText;
        if (isMiniMax) {
          fullText = await new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify({ messages });
            const parsed = new URL(`${MINIMAX_BASE}/chat`);
            const req2 = https.request(parsed, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "User-Agent":
                  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
              },
            });
            req2.on("error", reject);
            req2.on("response", (hfRes) => {
              let buffer = "";
              let full = "";
              let evt = "";
              hfRes.on("data", (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                  if (line.startsWith("event: ")) evt = line.slice(7).trim();
                  else if (line.startsWith("data: ") && evt !== "complete") {
                    try {
                      const d = JSON.parse(line.slice(6));
                      if (d.token) full += d.token;
                    } catch {}
                  }
                }
              });
              hfRes.on("end", () => resolve(full));
            });
            req2.write(bodyStr);
            req2.end();
          });
        } else {
          const submitRes = await submitToHF(prompt);
          if (!submitRes.event_id) {
            res.writeHead(502, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({ error: { message: "Upstream rejected" } })
            );
          }
          const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
          fullText = await collectSSE(sseUrl);
        }

        // Tool call detection only for Kimi
        const toolCalls =
          !isMiniMax ? tryParseToolCalls(fullText, body.tools) : null;
        const message = toolCalls
          ? { role: "assistant", content: null, tool_calls: toolCalls }
          : { role: "assistant", content: fullText };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: chatId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upstream.name,
            choices: [
              {
                index: 0,
                message,
                finish_reason: toolCalls ? "tool_calls" : "stop",
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
      const upstream = resolveUpstream(body.model);
      const stream = body.stream === true;
      const isMiniMax = upstream === UPSTREAMS.minimax;
      const hasTools = !isMiniMax && body.tools && body.tools.length > 0;
      const kimiMessages = hasTools ? injectToolPrompt(body.messages || [], body.tools) : body.messages || [];
      const messages = kimiMessages;
      const prompt = messagesToPrompt(kimiMessages);

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "messages required" },
          })
        );
      }

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const msgId = "msg_" + crypto.randomBytes(16).toString("hex");

        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: upstream.name,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`
        );

        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`
        );

        if (isMiniMax) {
          await streamMiniMax(messages, res, claudeFormatToken, upstream.name);
        } else {
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
          const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
          await streamAndCollect(sseUrl, res, claudeFormatToken);
        }

        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`
        );

        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`
        );

        res.write(
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`
        );

        res.end();
      } else {
        let fullText;
        if (isMiniMax) {
          fullText = await new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify({ messages });
            const parsed = new URL(`${MINIMAX_BASE}/chat`);
            const req2 = https.request(parsed, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "User-Agent":
                  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
              },
            });
            req2.on("error", reject);
            req2.on("response", (hfRes) => {
              let buffer = "";
              let full = "";
              let evt = "";
              hfRes.on("data", (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                  if (line.startsWith("event: ")) evt = line.slice(7).trim();
                  else if (line.startsWith("data: ") && evt !== "complete") {
                    try {
                      const d = JSON.parse(line.slice(6));
                      if (d.token) full += d.token;
                    } catch {}
                  }
                }
              });
              hfRes.on("end", () => resolve(full));
            });
            req2.write(bodyStr);
            req2.end();
          });
        } else {
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
          const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
          fullText = await collectSSE(sseUrl);
        }

        const msgId = "msg_" + crypto.randomBytes(16).toString("hex");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: msgId,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: fullText }],
            model: upstream.name,
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
      const model = body.model || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const upstream = resolveUpstream(model);

      if (upstream === UPSTREAMS.minimax) {
        const messages = [{ role: "user", content: prompt }];
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        await streamMiniMax(
          messages,
          res,
          (t) => `data: ${JSON.stringify([t])}\n\n`
        );
        res.end();
      } else {
        const submitRes = await submitToHF(prompt, history, image);
        if (!submitRes.event_id) {
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ error: "Upstream rejected", detail: submitRes })
          );
        }

        const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        return streamAndCollect(
          sseUrl,
          res,
          (t) => `data: ${JSON.stringify([t])}\n\n`
        );
      }
    }

    if (req.method === "POST" && req.url === "/chat/sync") {
      const prompt = body.prompt || "";
      const history = body.history_json || "";
      const image = body.image_b64 || "";
      const model = body.model || "";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "prompt is required" }));
      }

      const upstream = resolveUpstream(model);

      let fullText;
      if (upstream === UPSTREAMS.minimax) {
        const messages = [{ role: "user", content: prompt }];
        fullText = await new Promise((resolve, reject) => {
          const bodyStr = JSON.stringify({ messages });
          const parsed = new URL(`${MINIMAX_BASE}/chat`);
          const req2 = https.request(parsed, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "User-Agent":
                "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
            },
          });
          req2.on("error", reject);
          req2.on("response", (hfRes) => {
            let buffer = "";
            let full = "";
            let evt = "";
            hfRes.on("data", (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop();
              for (const line of lines) {
                if (line.startsWith("event: ")) evt = line.slice(7).trim();
                else if (line.startsWith("data: ") && evt !== "complete") {
                  try {
                    const d = JSON.parse(line.slice(6));
                    if (d.token) full += d.token;
                  } catch {}
                }
              }
            });
            hfRes.on("end", () => resolve(full));
          });
          req2.write(bodyStr);
          req2.end();
        });
      } else {
        const submitRes = await submitToHF(prompt, history, image);
        if (!submitRes.event_id) {
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ error: "Upstream rejected", detail: submitRes })
          );
        }

        const sseUrl = `${KIMI_BASE}/gradio_api/call/chat/${submitRes.event_id}`;
        fullText = await collectSSE(sseUrl);
      }

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
        routing: "model containing 'minimax' → MiniMax M3, otherwise → Kimi K2.7",
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
  console.log(`multi-ai proxy running on http://localhost:${PORT}`);
  console.log(`Kimi K2.7: ${KIMI_BASE}`);
  console.log(`MiniMax M3: ${MINIMAX_BASE}`);
  console.log(`GLM 5.1: ${GLM_BASE}`);
  console.log(`Routing: minimax→MiniMax, glm→GLM, default→Kimi`);
});
