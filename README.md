# Kimi K2.7 Code Proxy

Node.js proxy for [akhaliq/Kimi-K2.7-Code](https://akhaliq-kimi-k2-7-code.hf.space) Hugging Face Space.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + sync) |
| `POST` | `/v1/messages` | Claude-compatible messages (streaming + sync) |
| `GET` | `/v1/models` | List available models |
| `POST` | `/chat` | Streaming SSE proxy |
| `POST` | `/chat/sync` | Synchronous proxy |
| `GET` | `/health` | Health check |

## Setup

```bash
npm start
```

## Usage

### OpenAI-compatible

```bash
# Streaming
curl -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"kimi-k2.7-code","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Sync
curl -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"kimi-k2.7-code","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

### Claude-compatible

```bash
# Streaming
curl -X POST http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"kimi-k2.7-code","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Sync
curl -X POST http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"kimi-k2.7-code","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="unused")
response = client.chat.completions.create(
    model="kimi-k2.7-code",
    messages=[{"role": "user", "content": "Write a quicksort in Python"}],
    stream=True,
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Deploy

```bash
PORT=3000 node server.js
```

Zero dependencies — uses only Node built-ins.
