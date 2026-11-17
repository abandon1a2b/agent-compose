import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readSSE } from "../src/sse.ts";
import { createDeepSeekModel } from "../src/model.ts";
import { createChatHandler } from "../src/chat.ts";
import { createHttpServer } from "../src/server.ts";
import { tools } from "../src/tools/index.ts";
const frame = (delta: any, finish_reason: any = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
test("SSE decodes byte-split UTF-8, CRLF and multi-line data", async () => {
  const bytes = new TextEncoder().encode(
    "data: 你好\r\n\r\ndata: a\ndata: b\n\n",
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(Uint8Array.of(b));
      c.close();
    },
  });
  const result = [];
  for await (const s of readSSE(stream)) result.push(s);
  assert.deepEqual(result, ["你好", "a\nb"]);
});
test("streamed tool arguments are assembled before execution; text deltas precede done", async () => {
  let count = 0;
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    assert.equal(JSON.parse(body).stream, true);
    count++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (count === 1) {
      res.write(
        frame({
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "calculate", arguments: '{"operation":"add",' },
            },
          ],
        }),
      );
      res.write(
        frame({
          tool_calls: [{ index: 0, function: { arguments: '"a":2,"b":3}' } }],
        }),
      );
      res.write(frame({}, "tool_calls"));
    } else {
      res.write(frame({ content: "答案" }));
      res.write(frame({ content: "是5" }));
      res.write(frame({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const baseURL = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const server = createHttpServer(
    createChatHandler(createDeepSeekModel({ apiKey: "fake", baseURL }), tools),
    "test",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "2+3", stream: true }),
      },
    );
    assert.match(response.headers.get("content-type")!, /ndjson/);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.equal(events.filter((e) => e.type === "tool_end")[0].ok, true);
    assert.equal(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.text)
        .join(""),
      "答案是5",
    );
    assert.equal(events.at(-1).result.reply, "答案是5");
    assert.equal(events.at(-1).result.modelCalls, 2);
  } finally {
    server.closeAllConnections();
    server.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});
test("truncated provider stream fails instead of accepting partial answer", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ content: "半截" }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const model = createDeepSeekModel({
      apiKey: "fake",
      baseURL: `http://127.0.0.1:${(upstream.address() as any).port}`,
    });
    await assert.rejects(
      model.complete(
        [{ role: "user", content: "hello" }],
        [],
        AbortSignal.timeout(3000),
        { onDelta: () => {} },
      ),
      /提前中断/,
    );
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
});

test("HTTP exposes an early delta before the model finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const server = createHttpServer(
    createChatHandler(
      {
        async complete(_messages, _tools, _signal, options) {
          options?.onDelta?.("先到达");
          await gate;
          return { role: "assistant", content: "先到达，后完成" };
        },
      },
      [],
    ),
    "test",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello", stream: true }),
        signal: AbortSignal.timeout(5000),
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let early = "";
    while (!early.includes("text_delta")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      early += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(!early.includes('"type":"done"'));
    release();
    let rest = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(rest, /"type":"done"/);
  } finally {
    release();
    server.closeAllConnections();
    server.close();
  }
});
