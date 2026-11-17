export type ToolCall = { id: string; name: string; arguments: string };
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};
export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
};
export type Model = {
  complete: (
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal,
    options?: { maxOutputTokens?: number },
  ) => Promise<Message>;
};
export type ChatInput = {
  sessionId?: string;
  message: string;
  compress?: boolean;
};
export type ChatOutput = {
  sessionId: string;
  reply: string;
  modelCalls: number;
  toolCalls: { name: string; ok: boolean }[];
  compression: import("./compression.ts").CompressionInfo;
};
export type ChatHandler = (
  input: ChatInput,
  signal: AbortSignal,
) => Promise<ChatOutput>;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
