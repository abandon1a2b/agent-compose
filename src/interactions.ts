import { randomUUID } from "node:crypto";
import { HttpError, type Tool } from "./types.ts";
import type { TaskManager } from "./tasks/index.ts";
export type Card = {
  id: string;
  kind: "question" | "confirmation";
  title: string;
  options?: string[];
  taskId?: string;
  version?: number;
  snapshot?: unknown;
  status: "pending" | "completed";
};
export const INTERACTION_RULES =
  "需要用户补充信息时，可调用 render_interaction 生成 question 卡片，title写问题，options给最多4个建议选项。需要发布确认时，先完成草稿，再调用 render_interaction(kind=confirmation,title=确认说明)。不要生成HTML、脚本、URL动作或假按钮。调用后用简短文字结束本轮并等待用户，不重复生成相同卡片。卡片由用户操作，模型不能代替用户授权。";
export class Interactions {
  private cards = new Map<string, { sessionId: string; card: Card }>();
  tools(
    sessionId: string,
    tasks: TaskManager,
    onCard: (card: Card) => void,
  ): Tool[] {
    return [
      {
        name: "render_interaction",
        description:
          "按交互协议生成补问或确认卡片。确认卡片自动绑定服务端最新草稿快照。",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["question", "confirmation"] },
            title: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "title"],
          additionalProperties: false,
        },
        execute: (input) => {
          const i = input as any;
          if (
            !i ||
            !["question", "confirmation"].includes(i.kind) ||
            typeof i.title !== "string" ||
            !i.title.trim() ||
            i.title.length > 300 ||
            Object.keys(i).some(
              (k) => !["kind", "title", "options"].includes(k),
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
          else {
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
              mock: true,
            };
          }
          this.cards.set(card.id, { sessionId, card });
          onCard(structuredClone(card));
          return { interactionId: card.id, status: "waiting_for_user" };
        },
      },
    ];
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
    if (task.status === "succeeded") card.status = "completed";
    return {
      card: structuredClone(card),
      result: task.result,
      status: task.status,
    };
  }
}
