import type { Tool, ToolCall } from "./types.ts";

export type ToolResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/** Only registered tools can execute. Model-provided names never resolve to code paths. */
export function createToolExecutor(tools: Tool[]) {
  const registry = new Map<string, Tool>();
  for (const tool of tools) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) ||
      registry.has(tool.name)
    ) {
      throw new Error(`工具名称无效或重复：${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  return async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
    signal.throwIfAborted();
    try {
      const tool = registry.get(call.name);
      if (!tool) throw new Error(`未注册工具：${call.name}`);
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        throw new Error("工具参数必须是合法 JSON");
      }
      const value = await tool.execute(input, signal);
      signal.throwIfAborted();
      // Ensure a tool cannot break the next model request with a non-JSON result.
      const encoded = JSON.stringify(value ?? null);
      if (encoded === undefined) throw new Error("工具结果必须可序列化为 JSON");
      return { ok: true, value: JSON.parse(encoded) };
    } catch (error) {
      signal.throwIfAborted();
      return {
        ok: false,
        error: error instanceof Error ? error.message : "工具执行失败",
      };
    }
  };
}
