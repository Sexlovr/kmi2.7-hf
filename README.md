# Kimi K2.7 Code Proxy

Node.js proxy for [akhaliq/Kimi-K2.7-Code](https://akhaliq-kimi-k2-7-code.hf.space) Hugging Face Space.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Streaming SSE proxy — streams tokens as they arrive |
| `POST` | `/chat/sync` | Synchronous — waits for full response, returns JSON |
| `GET` | `/health` | Health check |

## Usage

```bash
npm install
npm start
```

### Streaming (SSE)

```bash
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Write a quicksort in Python"}'
```

### Synchronous

```bash
curl -X POST http://localhost:3000/chat/sync \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Write a quicksort in Python"}'
```

### Request Body

```json
{
  "prompt": "Your message",
  "history_json": "",
  "image_b64": ""
}
```

## Deploy

```bash
PORT=3000 node server.js
```

Set `PORT` env var to change the listening port.
