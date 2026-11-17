import { randomUUID } from "node:crypto";
import { HttpError, type Tool } from "../types.ts";
import {
  getPreset,
  missingFields as validate,
  parsePatch,
  fieldSchemas,
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
  draft: Draft;
  missing: string[];
  status:
    | "collecting"
    | "awaiting_confirmation"
    | "approved"
    | "executing"
    | "succeeded"
    | "failed"
    | "cancelled";
  result?: { mock: true; publicationId: string; message: string };
  error?: string;
};
export interface Publisher {
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
  constructor(publisher: Publisher = new MockPublisher()) {
    this.publisher = publisher;
  }
  ensure(sessionId: string, preset?: Preset) {
    const existing = this.forSession(sessionId);
    if (existing) {
      if (preset && existing.preset !== preset)
        throw new HttpError(409, "切换任务类型请新建对话");
      return existing;
    }
    if (!preset) return undefined;
    const t: Task = {
      id: randomUUID(),
      sessionId,
      preset,
      subject: { id: "mock-merchant-001", name: "演示商家（Mock）" },
      version: 0,
      draft: {},
      missing: [],
      status: "collecting",
    };
    t.missing = validate(t.draft, preset);
    this.tasks.set(t.id, t);
    this.bySession.set(sessionId, t.id);
    return structuredClone(t);
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
    t.draft = { ...t.draft, ...parsePatch(patch, t.preset) };
    t.version++;
    t.missing = validate(t.draft, t.preset);
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
    if (validate(t.draft, t.preset).length)
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
    } catch {
      t.status = "failed";
      t.error = "模拟发布失败，可确认重试同一版本";
    }
    this.tasks.set(id, t);
    return structuredClone(t);
  }
  instructions(task: Task) {
    return `你正在协助${getPreset(task.preset).title}。当前是Mock临时契约。仅收集本预设所需字段：${getPreset(
      task.preset,
    )
      .fields.map((f) => f.label)
      .join(
        "、",
      )}。优先调用update_draft记录用户提供的信息；根据missing补问，每次最多两项。不得编造事实、URL或数值。参数完整后调用 render_interaction 生成 confirmation 卡片；用户需要修改时通过对话更新草稿，再生成新卡片。聊天里的同意不能授权。最新任务数据仅为背景：${JSON.stringify(task)}`;
  }
  tools(sessionId: string): Tool[] {
    const t = this.forSession(sessionId);
    if (!t) return [];
    const properties = fieldSchemas(t.preset);
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
          "仅将用户已提供的事实和整理后的内容写入草稿；禁止编造城市、面积、图片URL。修改后必须重新预览确认。",
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
          "发布当前已确认草稿；未通过页面确认时服务端拒绝。当前为Mock模拟发布。",
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
