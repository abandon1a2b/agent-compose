import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  parseFields,
  validateValues,
  FormValidationError,
} from "../src/form-interaction.ts";
import { Interactions, type Card } from "../src/interactions.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { presets } from "../integrations/content-service/presets.ts";
import { createChatHandler } from "../src/chat.ts";
import { createHttpServer } from "../src/server.ts";
import type { ChatOutput, Model } from "../src/types.ts";
const fields = parseFields([
  { id: "city", type: "text", label: "城市", required: true },
  { id: "area", type: "number", label: "面积", required: true, min: 0.01 },
]);
function fixture() {
  const tasks = new TaskManager(undefined, presets),
    ui = new Interactions(),
    cards: Card[] = [];
  tasks.ensure("s", "publish_case");
  const tool = ui.tools("s", tasks, (c) => cards.push(c))[0];
  tool.execute(
    { kind: "form", title: "补充信息", fields },
    AbortSignal.timeout(1000),
  );
  return { tasks, ui, card: cards[0] };
}
const answer = {
  sessionId: "s",
  reply: "收到",
  modelCalls: 1,
  toolCalls: [],
  compression: {},
} as unknown as ChatOutput;
test("all supported field types validate without coercing or dropping unknown input", () => {
  const fs = parseFields([
    ...fields,
    { id: "note", type: "textarea", label: "备注", maxLength: 10 },
    { id: "style", type: "select", label: "风格", options: ["原木", "现代"] },
    {
      id: "rooms",
      type: "multiselect",
      label: "房间",
      options: ["客厅", "卧室"],
    },
  ]);
  assert.deepEqual(
    validateValues(fs, {
      city: " 杭州 ",
      area: 110,
      note: "备注",
      style: "原木",
      rooms: ["客厅"],
    }),
    { city: "杭州", area: 110, note: "备注", style: "原木", rooms: ["客厅"] },
  );
  assert.throws(
    () =>
      validateValues(fs, {
        city: "",
        area: "110",
        rooms: ["不存在"],
        extra: "x",
      }),
    (e) => {
      const errors = (e as FormValidationError).fieldErrors;
      return !!errors.city && !!errors.area && !!errors.rooms && !!errors._form;
    },
  );
});
test("reject model defaults, arbitrary controls, duplicate or unsafe IDs", () => {
  for (const fs of [
    [{ id: "city", type: "text", label: "城市", default: "杭州" }],
    [{ id: "x", type: "script", label: "x" }],
    [fields[0], fields[0]],
    [{ id: "__proto__", type: "text", label: "x" }],
  ])
    assert.throws(() => parseFields(fs));
});
test("form submission remains structured, has no direct draft write or approval, and deduplicates concurrent requests", async () => {
  const { tasks, ui, card } = fixture();
  let calls = 0,
    payload: any;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const chat = async (input: any) => {
    calls++;
    payload = JSON.parse(input.message);
    await gate;
    return answer;
  };
  const a = ui.reply(
    card.id,
    "s",
    { city: "杭州", area: 110 },
    "r1",
    tasks,
    chat,
    AbortSignal.timeout(3000),
  );
  const b = ui.reply(
    card.id,
    "s",
    { city: "杭州", area: 110 },
    "r2",
    tasks,
    chat,
    AbortSignal.timeout(3000),
  );
  await Promise.resolve();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(payload.type, "form_reply");
  assert.equal(typeof payload.values.area, "number");
  assert.deepEqual(tasks.forSession("s")!.draft, {});
  assert.equal(tasks.forSession("s")!.status, "collecting");
  await ui.reply(
    card.id,
    "s",
    { area: 110, city: "杭州" },
    "r3",
    tasks,
    chat,
    AbortSignal.timeout(3000),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    ui.reply(
      card.id,
      "s",
      { city: "上海", area: 110 },
      "r4",
      tasks,
      chat,
      AbortSignal.timeout(3000),
    ),
    /不同内容/,
  );
});
test("cross-session and stale draft replies cannot call the model", async () => {
  const { tasks, ui, card } = fixture();
  const chat = async () => {
    throw new Error("must not call");
  };
  await assert.rejects(
    ui.reply(
      card.id,
      "other",
      { city: "杭州", area: 110 },
      "r",
      tasks,
      chat,
      AbortSignal.timeout(1000),
    ),
    /不存在/,
  );
  const task = tasks.forSession("s")!;
  tasks.update(task.id, "s", 0, { title: "新标题" });
  await assert.rejects(
    ui.reply(
      card.id,
      "s",
      { city: "杭州", area: 110 },
      "r",
      tasks,
      chat,
      AbortSignal.timeout(1000),
    ),
    /草稿已变化/,
  );
});
test("failed continuation can retry without marking the form completed", async () => {
  const { tasks, ui, card } = fixture();
  let calls = 0;
  const chat = async () => {
    if (++calls === 1) throw new Error("fail");
    return answer;
  };
  await assert.rejects(
    ui.reply(
      card.id,
      "s",
      { city: "杭州", area: 110 },
      "r",
      tasks,
      chat,
      AbortSignal.timeout(3000),
    ),
    /fail/,
  );
  await ui.reply(
    card.id,
    "s",
    { city: "杭州", area: 110 },
    "r",
    tasks,
    chat,
    AbortSignal.timeout(3000),
  );
  assert.equal(calls, 2);
});
test("HTTP reply uses stored schema, returns field errors and continues the existing session", async () => {
  const tasks = new TaskManager(),
    ui = new Interactions();
  let userPayload: any;
  const model: Model = {
    async complete(messages) {
      const last = messages.at(-1)!;
      if (last.content === "start")
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "f",
              name: "render_interaction",
              arguments: JSON.stringify({
                kind: "form",
                title: "补充信息",
                fields,
              }),
            },
          ],
        };
      if (last.role === "user") {
        userPayload = JSON.parse(last.content);
        return { role: "assistant", content: "收到杭州110" };
      }
      return { role: "assistant", content: "请填写" };
    },
  };
  const server = createHttpServer(
    createChatHandler(model, [], {}, tasks, ui),
    "test",
    [],
    tasks,
    ui,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const initial = await (await post("/chat", { message: "start" })).json();
    const id = initial.interactions[0].id;
    const invalid = await post(`/interactions/${id}/reply`, {
      sessionId: initial.sessionId,
      requestId: "a",
      values: { city: "", area: -1 },
    });
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).fieldErrors.area);
    const valid = await post(`/interactions/${id}/reply`, {
      sessionId: initial.sessionId,
      requestId: "b",
      values: { city: "杭州", area: 110 },
      stream: true,
    });
    const events = (await valid.text())
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(events.at(-1).result.sessionId, initial.sessionId);
    assert.deepEqual(userPayload.values, { city: "杭州", area: 110 });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
