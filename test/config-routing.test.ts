import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateConfig, type ExecutorBinding } from "../src/config/index.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { Interactions } from "../src/interactions.ts";
import { createChatHandler } from "../src/chat.ts";
import { runLoop } from "../src/loop.ts";
import type { Model } from "../src/types.ts";
const runtime = () =>
  JSON.parse(
    readFileSync(new URL("../configs/runtime.json", import.meta.url), "utf8"),
  );
const app = () =>
  JSON.parse(
    readFileSync(
      new URL("../configs/applications/decoration.json", import.meta.url),
      "utf8",
    ),
  );
const executors: Record<string, ExecutorBinding> = {
  "content.publishCase": {
    requiresConfirmation: true,
    execute: async () => ({ mock: true, publicationId: "x", message: "ok" }),
  },
  "content.publishArticle": {
    requiresConfirmation: true,
    execute: async () => ({ mock: true, publicationId: "y", message: "ok" }),
  },
};
const signal = () => AbortSignal.timeout(5000);
test("configuration is strict, immutable, versioned and cannot disable approval", () => {
  const a = app(),
    r = runtime();
  const config = validateConfig(r, a, executors);
  a.role = "changed";
  assert.notEqual(config.application.role, a.role);
  assert.ok(Object.isFrozen(config.application.presets[0]));
  assert.equal(
    config.version,
    validateConfig(runtime(), app(), executors).version,
  );
  const unknown = app();
  unknown.presets[0].executor = "arbitrary.shell";
  assert.throws(() => validateConfig(runtime(), unknown, executors), /未注册/);
  const unsafe = app();
  unsafe.presets[0].confirmationRequired = false;
  assert.throws(() => validateConfig(runtime(), unsafe, executors), /不能取消/);
  assert.throws(
    () => validateConfig({ ...runtime(), typo: 1 }, app(), executors),
    /未知字段/,
  );
  const invalid = runtime();
  invalid.compression.targetRatio = 0.99;
  assert.throws(() => validateConfig(invalid, app(), executors), /比例/);
  const strict = app();
  strict.scope.mode = "strict";
  assert.throws(
    () => validateConfig(runtime(), strict, executors),
    /仅支持 prompt/,
  );
});
test("switch pauses previous drafts and invalidates both old forms and confirmations; resume preserves data", async () => {
  const config = validateConfig(runtime(), app(), executors);
  const tasks = new TaskManager(undefined, config.application.presets, {
    switching: true,
    configVersion: config.version,
  });
  const ui = new Interactions(),
    cards: any[] = [];
  let first = tasks.ensure("s", "publish_article")!;
  first = tasks.update(first.id, "s", 0, {
    title: "旧标题",
    content: "旧正文",
  });
  const render = ui.tools("s", tasks, (c) => cards.push(c))[0];
  await render.execute({ kind: "confirmation", title: "确认" }, signal());
  await render.execute(
    {
      kind: "form",
      title: "补充",
      fields: [{ id: "note", type: "text", label: "备注" }],
    },
    signal(),
  );
  const second = tasks.start("s", "publish_case");
  assert.deepEqual(second.draft, {});
  assert.equal(tasks.get(first.id, "s").status, "paused");
  assert.equal(second.configVersion, config.version);
  await assert.rejects(ui.confirm(cards[0].id, "s", tasks), /过期/);
  await assert.rejects(
    ui.reply(
      cards[1].id,
      "s",
      { note: "x" },
      "r",
      tasks,
      async () => {
        throw Error("not called");
      },
      signal(),
    ),
    /变化/,
  );
  const resumed = tasks.resume("s", first.id);
  assert.equal(resumed.draft.title, "旧标题");
  assert.equal(resumed.status, "awaiting_confirmation");
  assert.ok(resumed.version > first.version);
});
test("waiting interaction terminates without a decorative model call", async () => {
  const ui = new Interactions(),
    tasks = new TaskManager();
  let calls = 0;
  const model: Model = {
    async complete() {
      calls++;
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "q",
            name: "render_interaction",
            arguments: JSON.stringify({
              kind: "question",
              title: "请选择",
              options: ["A"],
            }),
          },
        ],
      };
    },
  };
  const output = await runLoop(
    model,
    ui.tools("s", tasks, () => {}),
    [{ role: "user", content: "hi" }],
    signal(),
    6,
    { stopOnAwaitingUser: true },
  );
  assert.equal(calls, 1);
  assert.equal(output.modelCalls, 1);
  assert.equal(output.messages.at(-1)?.role, "assistant");
});
test("natural task routing rebuilds context and keeps both model calls inside one budget", async () => {
  const config = validateConfig(runtime(), app(), executors);
  const tasks = new TaskManager(undefined, config.application.presets, {
    switching: true,
    configVersion: config.version,
  });
  let switching = false,
    seenFresh = false;
  const model: Model = {
    async complete(messages, tools) {
      const input = messages.filter((m) => m.role === "user").at(-1)!.content;
      if (input === "old secret")
        return { role: "assistant", content: "记住旧资料" };
      if (!switching) {
        switching = true;
        assert.ok(tools.some((t) => t.name === "start_task"));
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "switch",
              name: "start_task",
              arguments: '{"preset":"publish_article"}',
            },
          ],
        };
      }
      seenFresh = !JSON.stringify(messages).includes("old secret");
      assert.ok(tools.some((t) => t.name === "publish_article"));
      assert.ok(!tools.some((t) => t.name === "publish_case"));
      return { role: "assistant", content: "请提供新文章内容" };
    },
  };
  const chat = createChatHandler(
    model,
    [],
    config.runtime.compression,
    tasks,
    new Interactions(config.runtime.interaction),
    config,
  );
  const first = await chat(
    { message: "old secret", preset: "publish_case" },
    signal(),
  );
  const next = await chat(
    { sessionId: first.sessionId, message: "改发文章" },
    signal(),
  );
  assert.equal(next.task?.preset, "publish_article");
  assert.equal(next.modelCalls, 2);
  assert.equal(seenFresh, true);
  assert.equal(tasks.get(first.task!.id, first.sessionId).status, "paused");
});
