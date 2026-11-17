import { createToolExecutor } from "./tool-executor.ts";
import {
  HttpError,
  type Message,
  type Model,
  type Tool,
  type ChatEvent,
} from "./types.ts";
import { estimateInputTokens } from "./token-budget.ts";

/** One user turn: model -> tools -> model, until an answer or the step limit. */
export async function runLoop(
  model: Model,
  tools: Tool[],
  history: Message[],
  signal: AbortSignal,
  maxSteps = 6,
  limits: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    emit?: (event: ChatEvent) => void;
    stopOnAwaitingUser?: boolean;
  } = {},
) {
  const messages = [...history];
  const executeTool = createToolExecutor(tools);
  const trace: { name: string; ok: boolean }[] = [];
  for (let step = 1; step <= maxSteps; step++) {
    signal.throwIfAborted();
    if (
      estimateInputTokens(messages, tools) > (limits.maxInputTokens ?? Infinity)
    ) {
      throw new HttpError(
        422,
        "当前回合的输入或工具结果超过上下文预算；未拆分工具链，请缩小输入或工具结果",
      );
    }
    limits.emit?.({ type: "step_start", step });
    const answer = await model.complete(messages, tools, signal, {
      maxOutputTokens: limits.maxOutputTokens,
      onDelta: limits.emit
        ? (text) => limits.emit!({ type: "text_delta", text })
        : undefined,
    });
    signal.throwIfAborted();
    if (answer.role !== "assistant")
      throw new HttpError(502, "模型返回了错误的消息角色");
    messages.push(answer);
    const calls = answer.toolCalls ?? [];
    if (!calls.length) {
      if (!answer.content.trim()) throw new HttpError(502, "模型没有返回回答");
      return {
        messages,
        reply: answer.content,
        modelCalls: step,
        toolCalls: trace,
        contextChanged: false,
      };
    }
    if (
      calls.length > 4 ||
      new Set(calls.map((call) => call.id)).size !== calls.length
    ) {
      throw new HttpError(502, "模型工具调用数量或标识不合法");
    }
    if (
      calls.some(
        (call) =>
          tools.find((t) => t.name === call.name)?.control === "handoff",
      ) &&
      calls.length !== 1
    )
      throw new HttpError(502, "任务切换必须单独调用");
    let awaiting = false,
      handoff = false;
    for (const call of calls) {
      signal.throwIfAborted();
      limits.emit?.({ type: "tool_start", name: call.name });
      const output = await executeTool(call, signal);
      limits.emit?.({ type: "tool_end", name: call.name, ok: output.ok });
      if (output.ok) {
        const control = tools.find((t) => t.name === call.name)?.control;
        awaiting ||= control === "await_user";
        handoff ||= control === "handoff";
      }
      trace.push({ name: call.name, ok: output.ok });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(output),
      });
    }
    if (handoff || (awaiting && limits.stopOnAwaitingUser)) {
      messages.push({ role: "assistant", content: "" });
      return {
        messages,
        reply: answer.content,
        modelCalls: step,
        toolCalls: trace,
        contextChanged: handoff,
      };
    }
  }
  throw new HttpError(422, `模型调用已达到 ${maxSteps} 轮上限`);
}
