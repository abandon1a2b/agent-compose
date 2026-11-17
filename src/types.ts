export type ToolCall = { id: string; name: string; arguments: string };
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: import("./images.ts").ImageAttachment[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
};
export type Tool = {
  control?: "await_user" | "handoff";
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
    options?: { maxOutputTokens?: number; onDelta?: (text: string) => void },
  ) => Promise<Message>;
};
export type ChatInput = {
  sessionId?: string;
  message: string;
  compress?: boolean;
  images?: string[];
  stream?: boolean;
  preset?: import("./tasks/index.ts").Preset;
};
export type ChatOutput = {
  textParts?: string[];
  interactions?: import("./interactions.ts").Card[];
  task?: import("./tasks/index.ts").Task;
  sessionId: string;
  reply: string;
  modelCalls: number;
  toolCalls: { name: string; ok: boolean }[];
  compression: import("./compression.ts").CompressionInfo;
};
export type ChatEvent =
  | { type: "step_start"; step: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_start" | "tool_end"; name: string; ok?: boolean };
export type ChatHandler = (
  input: ChatInput,
  signal: AbortSignal,
  emit?: (event: ChatEvent) => void,
) => Promise<ChatOutput>;

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
