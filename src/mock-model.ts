import { randomUUID } from "node:crypto";
import type { Model } from "./types.ts";

/** Explicit offline demo for checking the loop, not a replacement for the DeepSeek API. */
export const mockModel: Model = {
  async complete(messages) {
    const last = messages.at(-1)!;
    if (last.role === "tool")
      return { role: "assistant", content: `[Mock] 工具返回：${last.content}` };
    if (/时间|几点|\btime\b/i.test(last.content)) {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: randomUUID(),
            name: "get_current_time",
            arguments: "{}",
          },
        ],
      };
    }
    const users = messages.filter((message) => message.role === "user");
    const content = /上一条|上次/.test(last.content)
      ? `上一条用户消息是：${users.at(-2)?.content ?? "没有上一条消息"}`
      : `第 ${users.length} 轮，收到：${last.content}`;
    return { role: "assistant", content: `[Mock] ${content}` };
  },
};
