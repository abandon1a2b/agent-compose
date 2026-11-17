# Optional content-service integration

This adapter is a reference business integration. Its counterpart is a separate local service, **not included in the AgentCompose repository**. The default configuration uses `MockContentPublisher`, so the chat demo can run without that service.

To connect a compatible service, set:

```dotenv
CONTENT_SERVICE_URL=http://127.0.0.1:4320
```

The adapter intentionally accepts only loopback HTTP origins for local validation. It does not send the model API key to this service.

## Required HTTP contract

| Endpoint | Contract |
| --- | --- |
| `POST /api/images` | Raw PNG/JPEG/WebP bytes; return `{id, url}` |
| `POST /api/cases` | JSON content and `Idempotency-Key` header |
| `POST /api/articles` | JSON content and `Idempotency-Key` header |

An article accepts `title`, `content` and optional `subject: {id, name}`.

A case additionally accepts `city` (a name, not an internal city ID), `area` in square metres, optional `style`, and `images` containing URLs owned by the content service.

A successful content submission returns at least:

```json
{"id":"business-resource-id","url":"http://127.0.0.1:4320/detail-url"}
```

A failed submission returns a non-2xx response with `{error: "message"}`. Repeated identical submissions using the same idempotency key should return the original record; conflicting payloads should return 409.

The adapter transfers uploaded Harness images to the business service before submitting a case. It does not automatically download arbitrary external image URLs. The content service must persist the copied images if they should survive a Harness restart.

## Files

- `integrations/content-service/publisher.ts`: HTTP transport and image transfer.
- `integrations/content-service/contracts.ts`: integration-specific publishing contract.
- `integrations/content-service/mock-publisher.ts`: offline publication simulation.
- `integrations/content-service/executors.ts`: bindings to the generic task execution interface.
- `configs/applications/decoration.json`: sample fields, role and executor names.

To integrate another business, supply its application configuration and executor bindings. Do not place its routes, resource identifiers or storage in the core runtime.
