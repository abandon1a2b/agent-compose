import {
  parseFields,
  validateValues,
  formFieldSchema,
  type FormField,
} from "./form-interaction.ts";
import type { ChatHandler, ChatOutput, ChatEvent } from "./types.ts";
import { randomUUID } from "node:crypto";
import { HttpError, type Tool } from "./types.ts";
import type { TaskManager } from "./tasks/index.ts";
export type Card = {
  id: string;
  kind: "question" | "confirmation" | "form";
  title: string;
  options?: string[];
  fields?: FormField[];
  submitLabel?: string;
  values?: Record<string, unknown>;
  taskId?: string;
  version?: number;
  snapshot?: unknown;
  result?: import("./tasks/index.ts").Task["result"];
  status: "pending" | "completed";
};
function interactionRules(policy: {
  allowedKinds: string[];
  maxFormFields: number;
}) {
  const rules = [
    "交互由模型调用render_interaction生成。不得生成HTML、脚本、URL动作或假按钮，不编造事实默认值；用户提交信息不是执行授权。",
  ];
  if (policy.allowedKinds.includes("form"))
    rules.push(
      `需要用户提供事实型信息时使用form，生成空输入框。fields支持text、textarea、number、select、multiselect，每次1–${policy.maxFormFields}项。表单回复以结构化form_reply传入，通过业务工具更新草稿。`,
    );
  if (policy.allowedKinds.includes("question"))
    rules.push(
      "question卡片用于选择或开放问题，最多4个建议选项，不能把猜测的事实当作答案。",
    );
  if (policy.allowedKinds.includes("confirmation"))
    rules.push(
      "需要执行确认时，先完成业务草稿，再生成confirmation卡片，模型不能代替用户授权。",
    );
  rules.push("生成交互后等待用户，不重复解释卡片内容。");
  return rules.join("");
}
export const INTERACTION_RULES = interactionRules({
  allowedKinds: ["question", "form", "confirmation"],
  maxFormFields: 6,
});
export class Interactions {
  private policy: { allowedKinds: string[]; maxFormFields: number };
  constructor(
    policy = {
      allowedKinds: ["question", "form", "confirmation"],
      maxFormFields: 6,
    },
  ) {
    this.policy = policy;
  }
  instructions() {
    return this.policy.allowedKinds.length
      ? interactionRules(this.policy)
      : "当前不提供交互组件，请用文字回复。";
  }
  private cards = new Map<string, { sessionId: string; card: Card }>();
  tools(
    sessionId: string,
    tasks: TaskManager,
    onCard: (card: Card) => void,
  ): Tool[] {
    if (!this.policy.allowedKinds.length) return [];
    return [
      {
        name: "render_interaction",
        control: "await_user",
        description:
          "按交互协议生成补问或确认卡片。确认卡片自动绑定服务端最新草稿快照。",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: this.policy.allowedKinds,
            },
            title: { type: "string" },
            fields: { type: "array", items: formFieldSchema },
            submitLabel: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "title"],
          additionalProperties: false,
        },
        execute: (input) => {
          const i = input as any;
          if (
            !i ||
            !this.policy.allowedKinds.includes(i.kind) ||
            typeof i.title !== "string" ||
            !i.title.trim() ||
            i.title.length > 300 ||
            Object.keys(i).some(
              (k) =>
                !["kind", "title", "options", "fields", "submitLabel"].includes(
                  k,
                ),
            )
          )
            throw new Error("交互描述不合法");
          if (
            i.options !== undefined &&
            (!Array.isArray(i.options) ||
              i.options.length > 4 ||
              i.options.some(
                (s: unknown) => typeof s !== "string" || s.length > 120,
              ))
          )
            throw new Error("选项最多4个，每项最多120字");
          const card: Card = {
            id: randomUUID(),
            kind: i.kind,
            title: i.title,
            status: "pending",
          };
          if (i.kind === "question") card.options = i.options ?? [];
          else if (i.kind === "form") {
            card.fields = parseFields(i.fields);
            if (card.fields.length > this.policy.maxFormFields)
              throw new Error("字段数量超过交互配置上限");
            if (
              i.submitLabel !== undefined &&
              (typeof i.submitLabel !== "string" ||
                !i.submitLabel.trim() ||
                i.submitLabel.length > 40)
            )
              throw new Error("提交按钮文案错误");
            card.submitLabel = i.submitLabel ?? "提交信息";
            const task = tasks.forSession(sessionId);
            if (task) {
              if (
                ![
                  "collecting",
                  "awaiting_confirmation",
                  "ready",
                  "failed",
                ].includes(task.status)
              )
                throw new Error("当前任务不能再收集信息");
              card.taskId = task.id;
              card.version = task.version;
            }
          } else {
            const task = tasks.forSession(sessionId);
            if (
              !task ||
              task.missing.length ||
              !["awaiting_confirmation", "failed"].includes(task.status)
            )
              throw new Error("草稿尚未准备好");
            card.taskId = task.id;
            card.version = task.version;
            card.snapshot = {
              subject: task.subject,
              draft: task.draft,
              execution: task.execution,
            };
          }
          this.cards.set(card.id, { sessionId, card });
          onCard(structuredClone(card));
          return { interactionId: card.id, status: "waiting_for_user" };
        },
      },
    ];
  }
  private replies = new Map<
    string,
    { fingerprint: string; promise: Promise<ChatOutput> }
  >();
  async reply(
    id: string,
    sessionId: string,
    input: unknown,
    requestId: string,
    tasks: TaskManager,
    chat: ChatHandler,
    signal: AbortSignal,
    emit?: (event: ChatEvent) => void,
  ): Promise<ChatOutput> {
    const record = this.cards.get(id);
    if (
      !record ||
      record.sessionId !== sessionId ||
      record.card.kind !== "form"
    )
      throw new HttpError(404, "回复表单不存在");
    if (typeof requestId !== "string" || !requestId || requestId.length > 100)
      throw new HttpError(400, "需要有效requestId");
    const card = record.card,
      values = validateValues(card.fields!, input),
      fingerprint = JSON.stringify(values);
    const previous = this.replies.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "此表单已提交不同内容",
          "interaction_already_answered",
        );
      return previous.promise;
    }
    if (card.taskId) {
      const task = tasks.get(card.taskId, sessionId);
      if (
        task.version !== card.version ||
        !["collecting", "awaiting_confirmation", "ready", "failed"].includes(
          task.status,
        )
      )
        throw new HttpError(
          409,
          "表单对应的草稿已变化，请在对话中请求新的表单",
          "stale_interaction",
        );
    }
    const message = JSON.stringify({
      type: "form_reply",
      interactionId: id,
      fields: card.fields!.map(({ id, label, type }) => ({ id, label, type })),
      values,
    });
    const promise = Promise.resolve().then(() =>
      chat({ sessionId, message }, signal, emit),
    );
    this.replies.set(id, { fingerprint, promise });
    try {
      const output = await promise;
      card.status = "completed";
      card.values = values;
      return output;
    } catch (error) {
      this.replies.delete(id);
      throw error;
    }
  }
  async confirm(id: string, sessionId: string, tasks: TaskManager) {
    const record = this.cards.get(id);
    if (
      !record ||
      record.sessionId !== sessionId ||
      record.card.kind !== "confirmation"
    )
      throw new HttpError(404, "确认卡片不存在");
    const card = record.card;
    const task = await tasks.confirm(card.taskId!, sessionId, card.version!);
    if (task.status === "succeeded") {
      card.status = "completed";
      card.result = task.result;
    }
    return {
      card: structuredClone(card),
      result: task.result,
      status: task.status,
    };
  }
}
