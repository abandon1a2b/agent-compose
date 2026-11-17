import type { Message, Tool } from "./types.ts";

// DeepSeek's documented 1M context window; use a conservative decimal interpretation.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** DeepSeek documents ~0.3 token/English char, ~0.6/Chinese char.
 * Include structure/tool schemas plus a 25% buffer. This is NOT a tokenizer or hard bound.
 */
export function estimateTextTokens(text: string): number {
  let total = 0;
  for (const character of text) {
    total += /\p{Script=Han}/u.test(character)
      ? 0.6
      : character.codePointAt(0)! < 128
        ? 0.3
        : 1;
  }
  return Math.ceil(total * 1.25);
}

export function estimateInputTokens(
  messages: Message[],
  tools: Tool[],
): number {
  const payload = JSON.stringify({
    messages: messages.map(({ role, content, toolCalls, toolCallId }) => ({
      role,
      content,
      toolCalls,
      toolCallId,
    })),
    tools: tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  });
  return (
    estimateTextTokens(payload) +
    messages.length * 8 +
    16 +
    messages.reduce((sum, m) => sum + (m.images?.length ?? 0) * 4096, 0)
  );
}
