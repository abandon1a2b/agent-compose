import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TaskManager } from "../src/tasks/index.ts";
import { validateConfig } from "../src/config/index.ts";
import { Interactions } from "../src/interactions.ts";
const runtime = () =>
  JSON.parse(
    readFileSync(new URL("../configs/runtime.json", import.meta.url), "utf8"),
  );
const application = () =>
  JSON.parse(
    readFileSync(
      new URL("../configs/applications/decoration.json", import.meta.url),
      "utf8",
    ),
  );
test("read-only no-input task executes without publication concepts or confirmation", async () => {
  const tasks = new TaskManager(
    {
      target: { label: "查询服务" },
      requiresConfirmation: () => false,
      execute: async () => ({ message: "查询完成", data: { count: 3 } }),
    },
    [
      {
        id: "count_items",
        title: "查询数量",
        fields: [],
        confirmationRequired: false,
      },
    ],
  );
  const task = tasks.ensure("s", "count_items")!;
  assert.equal(task.status, "ready");
  const result = await tasks.executeTask(task.id, "s");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.result, { message: "查询完成", data: { count: 3 } });
  assert.ok(!("publicationId" in result.result!));
});
test("code-registered write capability cannot be downgraded through definitions", () => {
  assert.throws(
    () =>
      new TaskManager(
        {
          requiresConfirmation: () => true,
          execute: async () => ({ message: "must not run" }),
        },
        [
          {
            id: "write",
            title: "写入",
            fields: [],
            confirmationRequired: false,
          },
        ],
      ),
    /不能降低/,
  );
});
test("plain chat config does not require tasks, execution bindings, or confirmation widgets", () => {
  const r = runtime(),
    a = application();
  r.interaction.allowedKinds = [];
  a.presets = [];
  assert.doesNotThrow(() => validateConfig(r, a, {}));
  const ui = new Interactions(r.interaction);
  assert.deepEqual(
    ui.tools("s", new TaskManager(), () => {}),
    [],
  );
});
test("config allows explicitly registered read-only task without confirmation widget", () => {
  const r = runtime(),
    a = application();
  r.interaction.allowedKinds = ["question"];
  a.presets = [
    {
      id: "lookup",
      title: "查询",
      executor: "lookup",
      instructions: "查询",
      fields: [],
      confirmationRequired: false,
    },
  ];
  assert.doesNotThrow(() =>
    validateConfig(r, a, {
      lookup: {
        requiresConfirmation: false,
        execute: async () => ({ message: "ok" }),
      },
    }),
  );
});
