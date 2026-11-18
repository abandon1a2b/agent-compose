# API & interaction protocol

The reference app serves UI and API on `http://127.0.0.1:4318`. APIs are local-development interfaces without production authentication.

## Chat

```http
POST /chat
Content-Type: application/json
```

```json
{"message":"请帮我整理一篇装修文章","preset":"publish_article","stream":true}
```

Optional fields: `sessionId` to continue a conversation, `images` containing uploaded image IDs, and `compress: true` to request a compaction attempt. Send the preset on the first turn; subsequent task changes can be handled by registered routing tools.

With `stream: true`, the response is newline-delimited JSON (`application/x-ndjson`):

```json
{"type":"step_start","step":1}
{"type":"text_delta","text":"请提供文章内容。"}
{"type":"tool_start","name":"render_interaction"}
{"type":"tool_end","name":"render_interaction","ok":true}
{"type":"done","result":{"sessionId":"...","reply":"...","interactions":[],"modelCalls":1,"toolCalls":[],"compression":{}}}
```

The last example abbreviates the result. The actual response includes full compaction metrics and can include `task` and `textParts`. Waiting interactions may end with an empty `reply`; clients must render `interactions` too.

Errors after streaming begins arrive as `{"type":"error","status":400,"message":"..."}`. Do not treat HTTP 200 alone as a successful completed turn. Without streaming, `/chat` returns a JSON result or a JSON error with the corresponding HTTP status.

## Interactions

The model calls `render_interaction` with one of:

- `question`: a title and up to four choices.
- `form`: a title and up to six typed fields.
- `confirmation`: a title; the server binds the real task, actor and revision.

The renderer accepts a bounded component vocabulary, not executable HTML or arbitrary action URLs.

### Form replies

```http
POST /interactions/:id/reply
Content-Type: application/json
```

```json
{"sessionId":"...","requestId":"client-generated-id","values":{"city":"杭州","area":110},"stream":true}
```

The server validates against its stored definition and continues the same conversation with a structured user message. Invalid fields return `fieldErrors`; invalid JSON or session references are rejected. Repeated submissions with the same normalized answer reuse the result. A stale task revision requires a new form.

### Confirmation

```http
POST /interactions/:id/confirm
Content-Type: application/json
```

```json
{"sessionId":"..."}
```

The client cannot replace the bound revision or execution arguments. The task manager verifies the snapshot before executing. A form reply or a conversational “yes” does not bypass this confirmation gate.

## Images

Upload raw bytes to `POST /images`, with `Content-Type: image/png`, `image/jpeg`, `image/webp`, `image/gif` or `image/avif`. Optional `X-File-Name` is URL-encoded. The response supplies an ID and local preview path.

Pass IDs in `/chat`'s `images` array. The model adapter resolves them to multimodal content. `GET /images/:id` serves previews. Images are memory-only, not permanent business assets.

## Discovery and tasks

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Health and model mode |
| `GET /presets` | Configured application presets |
| `GET /tools?sessionId=...` | Available tools for the session |
| `GET /tasks/:id?sessionId=...` | Task snapshot |
| `POST /tasks/:id/draft` | `{sessionId, version, patch}` |
| `POST /tasks/:id/confirm` | `{sessionId, version}` |
| `POST /tasks/:id/cancel` | `{sessionId}` |

Task execution requirements come from registered code capabilities. Read-only tasks may execute without approval; tasks that require confirmation cannot be downgraded by JSON configuration.

These endpoints currently use in-memory session identifiers as local access references. Integrate a real identity and permission layer before exposing them beyond local development.
