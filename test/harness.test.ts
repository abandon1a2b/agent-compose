import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createChatHandler } from "../src/chat.ts";
import { createDeepSeekModel, loadModel } from "../src/model.ts";
import { mockModel } from "../src/mock-model.ts";
import { createHttpServer } from "../src/server.ts";
import { runLoop } from "../src/loop.ts";
import { tools } from "../src/tools/index.ts";
import type { Model } from "../src/types.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const signal = () => AbortSignal.timeout(5000);

test("HTTP health, conversation continuation, isolated histories and input validation", async () => {
  const server = createHttpServer(createChatHandler(mockModel, tools), "mock");
  const base = await listen(server);
  const post = (body: unknown) =>
    fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
      status: "ok",
      modelMode: "mock",
    });
    const first = await (await post({ message: "我叫小明" })).json();
    const second = await (
      await post({ message: "上一条说了什么", sessionId: first.sessionId })
    ).json();
    assert.match(second.reply, /我叫小明/);
    const separate = await (await post({ message: "上一条说了什么" })).json();
    assert.match(separate.reply, /没有上一条消息/);
    assert.notEqual(first.sessionId, separate.sessionId);
    assert.equal((await post({ message: "" })).status, 400);
    assert.equal(
      (await post({ message: "你好", compress: "yes" })).status,
      400,
    );
    assert.equal(
      (await post({ message: "你好", sessionId: "missing" })).status,
      404,
    );
  } finally {
    await close(server);
  }
});

test("model -> tool -> model finishes in two calls", async () => {
  const result = await createChatHandler(mockModel, tools)(
    { message: "现在几点" },
    signal(),
  );
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.toolCalls, [{ name: "get_current_time", ok: true }]);
  assert.match(result.reply, /utc/);
});

test("tool input error is returned to the model so it can correct its call", async () => {
  let step = 0;
  const model: Model = {
    async complete(messages) {
      step++;
      if (step === 2)
        assert.equal(JSON.parse(messages.at(-1)!.content).ok, false);
      if (step < 3)
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `call-${step}`,
              name: "get_current_time",
              arguments: step === 1 ? "{bad-json" : "{}",
            },
          ],
        };
      return { role: "assistant", content: "已查询到时间" };
    },
  };
  const result = await runLoop(
    model,
    tools,
    [{ role: "user", content: "几点" }],
    signal(),
  );
  assert.equal(result.modelCalls, 3);
  assert.deepEqual(
    result.toolCalls.map((call) => call.ok),
    [false, true],
  );
});

test("the loop stops at its call limit", async () => {
  let calls = 0;
  const model: Model = {
    async complete() {
      calls++;
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: String(calls), name: "get_current_time", arguments: "{}" },
        ],
      };
    },
  };
  await assert.rejects(
    runLoop(model, tools, [{ role: "user", content: "loop" }], signal(), 3),
    /3 轮上限/,
  );
  assert.equal(calls, 3);
});

test("same-session concurrency is rejected; failed turns do not pollute history", async () => {
  let release!: () => void;
  const model: Model = {
    async complete(messages) {
      const text = messages.at(-1)!.content;
      if (text === "wait")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (text === "fail") throw new Error("provider failed");
      return {
        role: "assistant",
        content: messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("|"),
      };
    },
  };
  const chat = createChatHandler(model, []);
  const first = await chat({ message: "hello" }, signal());
  const pending = chat(
    { message: "wait", sessionId: first.sessionId },
    signal(),
  );
  await assert.rejects(
    chat({ message: "overlap", sessionId: first.sessionId }, signal()),
    /正在回答/,
  );
  release();
  await pending;
  await assert.rejects(
    chat({ message: "fail", sessionId: first.sessionId }, signal()),
    /provider failed/,
  );
  const result = await chat(
    { message: "next", sessionId: first.sessionId },
    signal(),
  );
  assert.equal(result.reply, "hello|wait|next");
});

test("DeepSeek wire protocol: bearer auth, non-thinking, tools and tool-result continuation", async () => {
  const requests: Record<string, any>[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fake-test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: requests.length === 1 ? "tool_calls" : "stop",
            message:
              requests.length === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "ds-call",
                        type: "function",
                        function: { name: "get_current_time", arguments: "{}" },
                      },
                    ],
                  }
                : { role: "assistant", content: "已获取当前时间" },
          },
        ],
      }),
    );
  });
  const baseURL = await listen(provider);
  try {
    const model = createDeepSeekModel({ apiKey: "fake-test-key", baseURL });
    const result = await createChatHandler(model, tools)(
      { message: "现在几点" },
      signal(),
    );
    assert.equal(result.reply, "已获取当前时间");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, "deepseek-flash");
    assert.equal(requests[0].stream, false);
    assert.deepEqual(requests[0].thinking, { type: "disabled" });
    assert.ok(
      requests[0].tools.some(
        (tool: any) => tool.function.name === "get_current_time",
      ),
    );
    assert.equal(requests[1].messages.at(-1).tool_call_id, "ds-call");
    assert.equal(JSON.parse(requests[1].messages.at(-1).content).ok, true);
  } finally {
    await close(provider);
  }
});

test("missing DeepSeek key fails explicitly; mock requires explicit selection", () => {
  assert.throws(() => loadModel({}), /DEEPSEEK_API_KEY/);
  assert.equal(loadModel({ MODEL_MODE: "mock" }).mode, "mock");
});

test("DeepSeek HTTP error is reported without exposing provider response body", async () => {
  const provider = createServer((_request, response) => {
    response.writeHead(401);
    response.end("private provider diagnostic");
  });
  const baseURL = await listen(provider);
  try {
    const model = createDeepSeekModel({ apiKey: "fake-test-key", baseURL });
    await assert.rejects(
      model.complete([{ role: "user", content: "hello" }], [], signal()),
      /DeepSeek API 返回 HTTP 401/,
    );
  } finally {
    await close(provider);
  }
});
