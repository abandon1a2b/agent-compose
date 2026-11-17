import { HttpError, type Message, type Model, type Tool } from "./types.ts";

/** One user turn: model -> tools -> model, until an answer or the step limit. */
export async function runLoop(
  model: Model,
  tools: Tool[],
  history: Message[],
  signal: AbortSignal,
  maxSteps = 6,
) {
  const messages = [...history];
  const trace: { name: string; ok: boolean }[] = [];
  for (let step = 1; step <= maxSteps; step++) {
    signal.throwIfAborted();
    const answer = await model.complete(messages, tools, signal);
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
      };
    }
    if (
      calls.length > 4 ||
      new Set(calls.map((call) => call.id)).size !== calls.length
    ) {
      throw new HttpError(502, "模型工具调用数量或标识不合法");
    }
    for (const call of calls) {
      signal.throwIfAborted();
      let output: { ok: boolean; value?: unknown; error?: string };
      try {
        const tool = tools.find((item) => item.name === call.name);
        if (!tool) throw new Error(`未注册工具：${call.name}`);
        let input: unknown;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          throw new Error("工具参数必须是合法 JSON");
        }
        const value = await tool.execute(input, signal);
        signal.throwIfAborted();
        output = { ok: true, value };
      } catch (error) {
        signal.throwIfAborted();
        output = {
          ok: false,
          error: error instanceof Error ? error.message : "工具执行失败",
        };
      }
      trace.push({ name: call.name, ok: output.ok });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(output),
      });
    }
  }
  throw new HttpError(422, `模型调用已达到 ${maxSteps} 轮上限`);
}
