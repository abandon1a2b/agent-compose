import { presets } from "../integrations/content-service/presets.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskManager,
  MockPublisher,
  type Publisher,
} from "../src/tasks/index.ts";
import { createToolExecutor } from "../src/tool-executor.ts";
import { createChatHandler } from "../src/chat.ts";
import { mockModel } from "../src/mock-model.ts";
import { createHttpServer } from "../src/server.ts";
import { once } from "node:events";
const draft = {
  title: "原木之家",
  content: "保留地板，增加收纳。",
  city: "上海",
  area: 90,
  images: ["https://example.com/mock.jpg"],
};
test("case requires fields, cannot publish without confirmation, and stale version is rejected", async () => {
  const m = new TaskManager(undefined, presets);
  let t = m.ensure("s", "publish_case")!;
  await assert.rejects(m.confirm(t.id, "s", 0), /未准备/);
  const executor = createToolExecutor(m.tools("s"));
  assert.equal(
    (
      await executor(
        { id: "x", name: "publish_case", arguments: "{}" },
        new AbortController().signal,
      )
    ).ok,
    false,
  );
  t = m.update(t.id, "s", 0, draft);
  assert.equal(t.status, "awaiting_confirmation");
  t = m.update(t.id, "s", 1, { title: "更新的标题" });
  await assert.rejects(m.confirm(t.id, "s", 1), /过期/);
  const result = await m.confirm(t.id, "s", 2);
  assert.equal(result.result?.mock, true);
  assert.equal(result.status, "succeeded");
  const replay = await m.confirm(t.id, "s", 2);
  assert.equal(replay.result?.publicationId, result.result?.publicationId);
  assert.throws(() => m.update(t.id, "s", 2, { title: "再修改" }), /不能修改/);
});
test("article shares workflow but has distinct fields and session ownership", async () => {
  const m = new TaskManager(undefined, presets);
  const t = m.ensure("a", "publish_article")!;
  assert.throws(() => m.get(t.id, "b"), /不存在/);
  assert.throws(() => m.update(t.id, "a", 0, { area: 90 }), /不支持/);
  const ready = m.update(t.id, "a", 0, { title: "标题", content: "正文" });
  assert.deepEqual(ready.missing, []);
  const result = await m.confirm(t.id, "a", 1);
  assert.equal(result.status, "succeeded");
  assert.throws(() => m.ensure("a", "publish_case"), /新建对话/);
});
test("invalid fields cannot satisfy validation and cancellation blocks confirmation", async () => {
  const m = new TaskManager(undefined, presets);
  const t = m.ensure("s", "publish_case")!;
  assert.throws(() => m.update(t.id, "s", 0, { area: -1 }), /面积/);
  assert.throws(
    () => m.update(t.id, "s", 0, { images: ["javascript:alert(1)"] }),
    /URL/,
  );
  const partial = m.update(t.id, "s", 0, { title: " ", content: "正文" });
  assert.ok(partial.missing.includes("标题"));
  m.cancel(t.id, "s");
  await assert.rejects(m.confirm(t.id, "s", 1), /取消/);
});
test("concurrent confirmations execute once and bind the unchanged snapshot", async () => {
  let release!: () => void,
    count = 0;
  let published: any;
  const publisher: Publisher = {
    async publish(_p, d, s, key) {
      count++;
      published = { d, s, key };
      await new Promise<void>((r) => (release = r));
      return { mock: true, publicationId: "mock-one", message: "模拟成功" };
    },
  };
  const m = new TaskManager(publisher, presets);
  const t = m.ensure("s", "publish_case")!;
  m.update(t.id, "s", 0, draft);
  const a = m.confirm(t.id, "s", 1),
    b = m.confirm(t.id, "s", 1);
  assert.equal(count, 1);
  assert.throws(
    () => m.update(t.id, "s", 1, { title: "偷偷修改" }),
    /不能修改/,
  );
  assert.throws(() => m.cancel(t.id, "s"), /不能取消/);
  release();
  assert.deepEqual(await a, await b);
  assert.deepEqual(published.d, draft);
  assert.equal(published.s.id, "mock-merchant-001");
});
test("failed publication retries the same idempotency key", async () => {
  const keys: string[] = [];
  const m = new TaskManager(
    {
      async publish(_p, _d, _s, key) {
        keys.push(key);
        if (keys.length === 1) throw new Error("test");
        return { mock: true, publicationId: "mock-id", message: "ok" };
      },
    },
    presets,
  );
  const t = m.ensure("s", "publish_article")!;
  m.update(t.id, "s", 0, { title: "t", content: "c" });
  assert.equal((await m.confirm(t.id, "s", 1)).status, "failed");
  assert.equal((await m.confirm(t.id, "s", 1)).status, "succeeded");
  assert.equal(keys[0], keys[1]);
});
test("HTTP task endpoints enforce version, session capability and duplicate confirmation", async () => {
  const manager = new TaskManager(undefined, presets);
  const server = createHttpServer(
    createChatHandler(mockModel, [], {}, manager),
    "mock",
    [],
    manager,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, data: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    const chat = await (
      await post("/chat", { message: "开始", preset: "publish_article" })
    ).json();
    const task = chat.task;
    assert.equal(task.preset, "publish_article");
    assert.equal(
      (
        await post(`/tasks/${task.id}/confirm`, {
          sessionId: "other",
          version: 0,
        })
      ).status,
      404,
    );
    const updated = await (
      await post(`/tasks/${task.id}/draft`, {
        sessionId: chat.sessionId,
        version: 0,
        patch: { title: "测试文章", content: "测试正文" },
      })
    ).json();
    assert.equal(updated.status, "awaiting_confirmation");
    assert.equal(
      (
        await post(`/tasks/${task.id}/confirm`, {
          sessionId: chat.sessionId,
          version: 0,
        })
      ).status,
      409,
    );
    const a = await (
      await post(`/tasks/${task.id}/confirm`, {
        sessionId: chat.sessionId,
        version: 1,
      })
    ).json();
    const b = await (
      await post(`/tasks/${task.id}/confirm`, {
        sessionId: chat.sessionId,
        version: 1,
      })
    ).json();
    assert.equal(a.result.publicationId, b.result.publicationId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
