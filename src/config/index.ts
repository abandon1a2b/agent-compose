import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  validateCompressionPolicy,
  type CompressionPolicy,
} from "../compression.ts";
import type { TaskDefinition } from "../tasks/presets.ts";
export type RuntimeConfig = {
  schemaVersion: 1;
  maxModelSteps: number;
  requestTimeoutMs: number;
  interaction: {
    stopOnAwaitingUser: boolean;
    allowedKinds: string[];
    maxFormFields: number;
  };
  compression: CompressionPolicy;
};
export type ApplicationConfig = {
  schemaVersion: 1;
  id: string;
  role: string;
  subject: { id: string; name: string };
  scope: { mode: "prompt"; allowedTopics: string[]; outOfScopeReply: string };
  taskSwitching: { enabled: boolean; previousTask: "pause"; reuseDraft: "ask" };
  presets: (TaskDefinition & {
    executor: string;
    confirmationRequired: boolean;
    instructions: string;
  })[];
};
export type ExecutorBinding = {
  requiresConfirmation: boolean;
  execute: import("../tasks/executor.ts").TaskExecutor["execute"];
};
function keys(v: any, allowed: string[], where: string) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !allowed.includes(k))
  )
    throw new Error(`${where} 含未知字段或格式错误`);
}
function text(v: any, where: string) {
  if (typeof v !== "string" || !v.trim() || v.length > 12000)
    throw new Error(`${where} 必须是非空文本`);
}
function integer(v: any, min: number, max: number, where: string) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new Error(`${where} 超出有效范围`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
export function validateConfig(
  runtime: any,
  app: any,
  executors: Record<string, ExecutorBinding>,
) {
  keys(
    runtime,
    [
      "schemaVersion",
      "maxModelSteps",
      "requestTimeoutMs",
      "interaction",
      "compression",
    ],
    "runtime",
  );
  if (runtime.schemaVersion !== 1)
    throw new Error("runtime schemaVersion 必须是1");
  integer(runtime.maxModelSteps, 1, 30, "maxModelSteps");
  integer(runtime.requestTimeoutMs, 1000, 300000, "requestTimeoutMs");
  keys(
    runtime.interaction,
    ["stopOnAwaitingUser", "allowedKinds", "maxFormFields"],
    "interaction",
  );
  if (
    typeof runtime.interaction.stopOnAwaitingUser !== "boolean" ||
    !Array.isArray(runtime.interaction.allowedKinds) ||
    runtime.interaction.allowedKinds.some(
      (k: any) => !["question", "form", "confirmation"].includes(k),
    )
  )
    throw new Error("交互配置错误");
  integer(runtime.interaction.maxFormFields, 1, 6, "maxFormFields");
  if (
    new Set(runtime.interaction.allowedKinds).size !==
    runtime.interaction.allowedKinds.length
  )
    throw new Error("交互类型重复");
  keys(
    runtime.compression,
    [
      "enabled",
      "contextWindowTokens",
      "reservedOutputTokens",
      "triggerRatio",
      "targetRatio",
      "keepRecentTurns",
      "summaryMaxTokens",
    ],
    "compression",
  );
  if (typeof runtime.compression.enabled !== "boolean")
    throw new Error("compression.enabled 类型错误");
  validateCompressionPolicy(runtime.compression);
  keys(
    app,
    [
      "schemaVersion",
      "id",
      "role",
      "subject",
      "scope",
      "taskSwitching",
      "presets",
    ],
    "application",
  );
  if (app.schemaVersion !== 1)
    throw new Error("application schemaVersion 必须是1");
  text(app.id, "id");
  text(app.role, "role");
  keys(app.subject, ["id", "name"], "subject");
  text(app.subject.id, "subject.id");
  text(app.subject.name, "subject.name");
  if (app.subject.id.length > 100 || app.subject.name.length > 200)
    throw new Error("主体标识超长");
  keys(app.scope, ["mode", "allowedTopics", "outOfScopeReply"], "scope");
  if (app.scope.mode !== "prompt")
    throw new Error("当前仅支持 prompt 范围策略，不提供严格语义拦截保证");
  if (
    !Array.isArray(app.scope.allowedTopics) ||
    !app.scope.allowedTopics.length
  )
    throw new Error("allowedTopics 不能为空");
  app.scope.allowedTopics.forEach((t: any) => text(t, "topic"));
  text(app.scope.outOfScopeReply, "outOfScopeReply");
  keys(
    app.taskSwitching,
    ["enabled", "previousTask", "reuseDraft"],
    "taskSwitching",
  );
  if (
    typeof app.taskSwitching.enabled !== "boolean" ||
    app.taskSwitching.previousTask !== "pause" ||
    app.taskSwitching.reuseDraft !== "ask"
  )
    throw new Error("当前仅支持保留旧任务、询问复用的切换策略");
  if (!Array.isArray(app.presets)) throw new Error("presets 必须是数组");
  const ids = new Set();
  for (const p of app.presets) {
    keys(
      p,
      [
        "id",
        "title",
        "fields",
        "executor",
        "instructions",
        "confirmationRequired",
      ],
      "preset",
    );
    if (
      typeof p.id !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(p.id) ||
      ids.has(p.id) ||
      [
        "start_task",
        "resume_task",
        "get_task",
        "update_draft",
        "render_interaction",
      ].includes(p.id)
    )
      throw new Error("预设ID重复、保留或非法");
    ids.add(p.id);
    text(p.title, "preset.title");
    text(p.instructions, "instructions");
    const binding = Object.hasOwn(executors, p.executor)
      ? executors[p.executor]
      : undefined;
    if (
      !binding ||
      typeof binding.execute !== "function" ||
      typeof binding.requiresConfirmation !== "boolean"
    )
      throw new Error(`未注册执行器 ${p.executor}`);
    if (
      typeof p.confirmationRequired !== "boolean" ||
      (binding.requiresConfirmation && !p.confirmationRequired)
    )
      throw new Error("配置不能取消执行器要求的授权约束");
    if (
      p.confirmationRequired &&
      !runtime.interaction.allowedKinds.includes("confirmation")
    )
      throw new Error("需确认的任务缺少confirmation交互");
    if (!Array.isArray(p.fields) || p.fields.length > 30)
      throw new Error("字段列表错误");
    const names = new Set();
    for (const f of p.fields) {
      keys(
        f,
        [
          "name",
          "label",
          "kind",
          "required",
          "draftBy",
          "maxLength",
          "min",
          "max",
          "maxItems",
        ],
        "field",
      );
      if (
        typeof f.name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f.name) ||
        ["constructor", "prototype"].includes(f.name) ||
        names.has(f.name)
      )
        throw new Error("字段名错误");
      names.add(f.name);
      text(f.label, "field.label");
      if (
        !["text", "textarea", "number", "url-list"].includes(f.kind) ||
        (f.draftBy !== undefined && !["assistant", "user"].includes(f.draftBy)) ||
        (f.required !== undefined && typeof f.required !== "boolean")
      )
        throw new Error("字段类型错误");
      if (f.maxLength !== undefined)
        integer(f.maxLength, 1, 12000, "maxLength");
      if (f.maxItems !== undefined) integer(f.maxItems, 1, 20, "maxItems");
      for (const k of ["min", "max"])
        if (
          f[k] !== undefined &&
          (f.kind !== "number" ||
            typeof f[k] !== "number" ||
            !Number.isFinite(f[k]))
        )
          throw new Error("数值范围错误");
      if (f.min !== undefined && f.max !== undefined && f.min > f.max)
        throw new Error("数值范围错误");
    }
  }
  const version = createHash("sha256")
    .update(JSON.stringify({ runtime, app }))
    .digest("hex")
    .slice(0, 16);
  return freeze({
    runtime: structuredClone(runtime) as RuntimeConfig,
    application: structuredClone(app) as ApplicationConfig,
    version,
  });
}
export function loadConfig(
  runtimePath: string | URL,
  applicationPath: string | URL,
  executors: Record<string, ExecutorBinding>,
) {
  return validateConfig(
    JSON.parse(readFileSync(runtimePath, "utf8")),
    JSON.parse(readFileSync(applicationPath, "utf8")),
    executors,
  );
}
