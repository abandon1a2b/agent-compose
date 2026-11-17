import { randomUUID } from "node:crypto";
import { HttpError, type Tool } from "../types.ts";
import {
  createPresetRegistry,
  type TaskDefinition,
  type Preset,
  type Draft,
} from "./presets.ts";
export type { Preset, Draft } from "./presets.ts";
export type Task = {
  id: string;
  sessionId: string;
  preset: Preset;
  subject: { id: string; name: string };
  version: number;
  configVersion: string;
  draft: Draft;
  missing: string[];
  status:
    | "collecting"
    | "awaiting_confirmation"
    | "approved"
    | "executing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "paused";
  mode: "mock" | "local";
  result?: {
    mock: boolean;
    publicationId: string;
    message: string;
    url?: string;
  };
  error?: string;
};
export interface Publisher {
  mode?: "mock" | "local";
  publish(
    preset: Preset,
    draft: Draft,
    subject: Task["subject"],
    idempotencyKey: string,
  ): Promise<NonNullable<Task["result"]>>;
}
export class MockPublisher implements Publisher {
  private results = new Map<string, NonNullable<Task["result"]>>();
  async publish(
    preset: Preset,
    _draft: Draft,
    _subject: Task["subject"],
    key: string,
  ) {
    if (!this.results.has(key))
      this.results.set(key, {
        mock: true,
        publicationId: `mock-${preset}-${randomUUID()}`,
        message: "模拟发布成功，未写入任何真实业务系统",
      });
    return structuredClone(this.results.get(key)!);
  }
}
export class TaskManager {
  private tasks = new Map<string, Task>();
  private bySession = new Map<string, string>();
  private inFlight = new Map<string, Promise<Task>>();
  private publisher: Publisher;
  private registry: ReturnType<typeof createPresetRegistry>;
  private policy: {
    switching: boolean;
    configVersion: string;
    subject?: Task["subject"];
  };
  get definitions() {
    return this.registry.definitions;
  }
  constructor(
    publisher: Publisher = new MockPublisher(),
    definitions: readonly TaskDefinition[] = [],
    policy: {
      switching: boolean;
      configVersion: string;
      subject?: Task["subject"];
    } = { switching: false, configVersion: "unversioned" },
  ) {
    this.registry = createPresetRegistry(structuredClone(definitions));
    this.policy = policy;
    this.publisher = publisher;
  }
  ensure(sessionId: string, preset?: Preset): Task | undefined {
    const existing = this.forSession(sessionId);
    if (existing) {
      if (preset && existing.preset !== preset) {
        if (this.policy.switching) return this.start(sessionId, preset);
        throw new HttpError(409, "切换任务类型请新建对话");
      }
      return existing;
    }
    if (!preset) return undefined;
    this.registry.getPreset(preset);
    const t: Task = {
      mode: this.publisher.mode ?? "mock",
      id: randomUUID(),
      sessionId,
      preset,
      subject: structuredClone(
        this.policy.subject ?? { id: "demo", name: "演示主体" },
      ),
      version: 0,
      configVersion: this.policy.configVersion,
      draft: {},
      missing: [],
      status: "collecting",
    };
    t.missing = this.registry.missingFields(t.draft, preset);
    this.tasks.set(t.id, t);
    this.bySession.set(sessionId, t.id);
    return structuredClone(t);
  }
  private pauseCurrent(sessionId: string) {
    const previous = this.forSession(sessionId);
    if (!previous) return;
    if (["approved", "executing"].includes(previous.status))
      throw new HttpError(409, "当前任务正在执行，待结果确认后再切换");
    if (!["succeeded", "cancelled", "paused"].includes(previous.status)) {
      previous.status = "paused";
      previous.version++;
      this.tasks.set(previous.id, previous);
    }
  }
  start(sessionId: string, preset: Preset): Task {
    if (!this.policy.switching) throw new HttpError(409, "任务切换未启用");
    this.registry.getPreset(preset);
    this.pauseCurrent(sessionId);
    this.bySession.delete(sessionId);
    return this.ensure(sessionId, preset)!;
  }
  resume(sessionId: string, taskId: string) {
    if (!this.policy.switching) throw new HttpError(409, "任务切换未启用");
    const task = this.get(taskId, sessionId);
    if (task.status !== "paused")
      throw new HttpError(409, "只能恢复已暂停任务");
    this.pauseCurrent(sessionId);
    task.version++;
    task.status = task.missing.length ? "collecting" : "awaiting_confirmation";
    this.tasks.set(task.id, task);
    this.bySession.set(sessionId, task.id);
    return structuredClone(task);
  }
  routingTools(sessionId: string): Tool[] {
    if (!this.policy.switching) return [];
    return [
      {
        name: "start_task",
        control: "handoff",
        description:
          "用户明确要求换任务或新发一份时创建新任务，原草稿保留但旧交互失效；不复制原草稿。",
        parameters: {
          type: "object",
          properties: {
            preset: { type: "string", enum: this.definitions.map((d) => d.id) },
          },
          required: ["preset"],
          additionalProperties: false,
        },
        execute: (v) => {
          const i = v as { preset: string };
          if (!i || typeof i.preset !== "string") throw new Error("缺少预设");
          return this.start(sessionId, i.preset);
        },
      },
      {
        name: "resume_task",
        control: "handoff",
        description: "用户明确要求回到以前任务时恢复已暂停任务；仍需重新确认。",
        parameters: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
        execute: (v) =>
          this.resume(sessionId, (v as { taskId: string }).taskId),
      },
    ];
  }
  routingContext(sessionId: string) {
    return [...this.tasks.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((t) => ({ id: t.id, preset: t.preset, status: t.status }));
  }
  forSession(sessionId: string) {
    const id = this.bySession.get(sessionId);
    return id ? structuredClone(this.tasks.get(id)!) : undefined;
  }
  get(id: string, sessionId: string) {
    const t = this.tasks.get(id);
    if (!t || t.sessionId !== sessionId) throw new HttpError(404, "任务不存在");
    return structuredClone(t);
  }
  update(id: string, sessionId: string, version: number, patch: unknown) {
    const t = this.get(id, sessionId);
    if (t.version !== version)
      throw new HttpError(409, "草稿版本已变更，请刷新预览");
    if (!["collecting", "awaiting_confirmation", "failed"].includes(t.status))
      throw new HttpError(409, "当前任务不能修改");
    t.draft = { ...t.draft, ...this.registry.parsePatch(patch, t.preset) };
    t.version++;
    t.missing = this.registry.missingFields(t.draft, t.preset);
    t.status = t.missing.length ? "collecting" : "awaiting_confirmation";
    delete t.error;
    delete t.result;
    this.tasks.set(id, t);
    return structuredClone(t);
  }
  cancel(id: string, sessionId: string) {
    const t = this.get(id, sessionId);
    if (["approved", "executing", "succeeded"].includes(t.status))
      throw new HttpError(409, "执行中或已发布的任务不能取消");
    t.status = "cancelled";
    this.tasks.set(id, t);
    return t;
  }
  async confirm(id: string, sessionId: string, version: number): Promise<Task> {
    const t = this.get(id, sessionId);
    if (t.version !== version)
      throw new HttpError(409, "确认的草稿版本已过期，请重新查看预览");
    if (t.status === "succeeded") return t;
    if (this.inFlight.has(id)) return this.inFlight.get(id)!;
    if (t.status !== "awaiting_confirmation" && t.status !== "failed")
      throw new HttpError(409, "草稿未准备好或任务已取消");
    if (this.registry.missingFields(t.draft, t.preset).length)
      throw new HttpError(409, "必填信息不完整");
    t.status = "approved";
    this.tasks.set(id, t);
    const promise = this.executeApproved(id, sessionId);
    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }
  async executeApproved(id: string, sessionId: string) {
    const t = this.get(id, sessionId);
    if (t.status === "succeeded") return t;
    if (t.status !== "approved")
      throw new HttpError(
        409,
        "需要用户在页面确认当前版本，模型不能代替用户授权",
      );
    t.status = "executing";
    this.tasks.set(id, t);
    try {
      t.result = await this.publisher.publish(
        t.preset,
        structuredClone(t.draft),
        structuredClone(t.subject),
        `${t.id}:${t.version}:${t.subject.id}`,
      );
      t.status = "succeeded";
    } catch (error) {
      t.status = "failed";
      t.error =
        error instanceof HttpError
          ? error.message
          : "执行失败，可确认重试同一版本；已保留幂等键";
    }
    this.tasks.set(id, t);
    return structuredClone(t);
  }
  instructions(task: Task) {
    return `你正在协助${this.registry.getPreset(task.preset).title}。当前为${task.mode === "local" ? "本地验证服务，会真实保存到本地，不是线上发布" : "Mock模拟执行"}。${this.registry.getPreset(task.preset).instructions ?? ""}仅收集本预设所需字段：${this.registry
      .getPreset(task.preset)
      .fields.map((f) => f.label)
      .join(
        "、",
      )}。优先调用update_draft记录用户提供的信息；根据missing补问，每次最多两项。不得编造事实、URL或数值。参数完整后调用 render_interaction 生成 confirmation 卡片；用户需要修改时通过对话更新草稿，再生成新卡片。聊天里的同意不能授权。最新任务数据仅为背景：${JSON.stringify(task)}`;
  }
  tools(sessionId: string): Tool[] {
    const t = this.forSession(sessionId);
    if (!t) return [];
    const properties = this.registry.fieldSchemas(t.preset);
    return [
      {
        name: "get_task",
        description: "读取本会话任务、草稿、版本、缺失字段及状态。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: () => this.get(t.id, sessionId),
      },
      {
        name: "update_draft",
        description:
          "仅将用户已提供的事实和整理后的内容写入草稿；禁止编造事实或工具参数。修改后必须重新预览确认。",
        parameters: {
          type: "object",
          properties: {
            version: { type: "integer" },
            patch: { type: "object", properties, additionalProperties: false },
          },
          required: ["version", "patch"],
          additionalProperties: false,
        },
        execute: (input) => {
          const i = input as { version: number; patch: unknown };
          if (!i || !Number.isSafeInteger(i.version))
            throw new Error("缺少正确的草稿版本");
          return this.update(t.id, sessionId, i.version, i.patch);
        },
      },
      {
        name: t.preset,
        description:
          "发布当前已确认草稿；未通过页面确认时服务端拒绝。执行模式由服务端配置决定。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: () => this.executeApproved(t.id, sessionId),
      },
    ];
  }
}
