import { readSSE } from "./sse.ts";
import { HttpError, type Model, type ToolCall } from "./types.ts";
import { mockModel } from "./mock-model.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./token-budget.ts";

type Options = {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxOutputTokens?: number;
};
export function createDeepSeekModel(options: Options): Model {
  const baseURL = options.baseURL ?? "https://api.deepseek.com";
  const model = options.model ?? "deepseek-flash";
  return {
    async complete(messages, tools, signal, callOptions) {
      let response: Response;
      try {
        response = await fetch(
          `${baseURL.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              stream: !!callOptions?.onDelta,
              thinking: { type: "disabled" },
              max_tokens:
                callOptions?.maxOutputTokens ??
                options.maxOutputTokens ??
                DEFAULT_MAX_OUTPUT_TOKENS,
              messages: messages.map((message) => ({
                role: message.role,
                content: message.images?.length
                  ? [
                      { type: "text", text: message.content },
                      ...message.images.map((image) => ({
                        type: "image_url",
                        image_url: { url: image.url },
                      })),
                    ]
                  : message.content,
                ...(message.toolCallId
                  ? { tool_call_id: message.toolCallId }
                  : {}),
                ...(message.toolCalls?.length
                  ? {
                      tool_calls: message.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: call.arguments,
                        },
                      })),
                    }
                  : {}),
              })),
              ...(tools.length
                ? {
                    tools: tools.map((tool) => ({
                      type: "function",
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      },
                    })),
                  }
                : {}),
            }),
          },
        );
      } catch {
        signal.throwIfAborted();
        throw new HttpError(502, "无法连接 DeepSeek API");
      }
      if (!response.ok)
        throw new HttpError(502, `DeepSeek API 返回 HTTP ${response.status}`);
      if (callOptions?.onDelta) {
        if (!response.body) throw new HttpError(502, "DeepSeek 流为空");
        let content = "",
          finished = false,
          done = false;
        const calls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        for await (const frame of readSSE(response.body)) {
          signal.throwIfAborted();
          if (frame === "[DONE]") {
            done = true;
            break;
          }
          let part: any;
          try {
            part = JSON.parse(frame);
          } catch {
            throw new HttpError(502, "DeepSeek 流格式错误");
          }
          if (part.error) throw new HttpError(502, "DeepSeek 流返回错误");
          const choice = part.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason === "length")
            throw new HttpError(502, "DeepSeek 输出达到长度上限");
          if (choice.finish_reason) {
            if (!["stop", "tool_calls"].includes(choice.finish_reason))
              throw new HttpError(502, "DeepSeek 未正常完成");
            finished = true;
          }
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string") {
            content += delta.content;
            callOptions.onDelta(delta.content);
          }
          for (const item of delta.tool_calls ?? []) {
            if (
              !Number.isInteger(item.index) ||
              item.index < 0 ||
              item.index > 3
            )
              throw new HttpError(502, "工具流索引错误");
            const call = calls.get(item.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (item.id) call.id = item.id;
            if (item.function?.name) call.name += item.function.name;
            if (item.function?.arguments)
              call.arguments += item.function.arguments;
            calls.set(item.index, call);
          }
        }
        if (
          !done ||
          !finished ||
          [...calls.values()].some((c) => !c.id || !c.name)
        )
          throw new HttpError(502, "DeepSeek 流提前中断，未提交本轮对话");
        return {
          role: "assistant",
          content,
          toolCalls: [...calls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, call]) => call),
        };
      }
      let data: {
        choices?: {
          message?: Record<string, unknown>;
          finish_reason?: string;
        }[];
      };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        throw new HttpError(502, "DeepSeek 返回了无效 JSON");
      }
      if (data?.choices?.[0]?.finish_reason === "length")
        throw new HttpError(502, "DeepSeek 输出达到长度上限，请缩小问题");
      const message = data?.choices?.[0]?.message;
      if (
        !message ||
        message.role !== "assistant" ||
        (message.content != null && typeof message.content !== "string")
      ) {
        throw new HttpError(502, "模型响应不符合 Chat Completions 协议");
      }
      const toolCalls: ToolCall[] = [];
      if (message.tool_calls != null) {
        if (!Array.isArray(message.tool_calls))
          throw new HttpError(502, "模型工具调用格式错误");
        for (const call of message.tool_calls) {
          if (
            !call ||
            typeof call.id !== "string" ||
            !call.id ||
            call.type !== "function" ||
            typeof call.function?.name !== "string" ||
            typeof call.function?.arguments !== "string"
          ) {
            throw new HttpError(502, "模型工具调用格式错误");
          }
          toolCalls.push({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      return {
        role: "assistant",
        content: (message.content as string) ?? "",
        toolCalls,
      };
    },
  };
}

export function loadModel(env = process.env): { mode: string; model: Model } {
  const mode = env.MODEL_MODE ?? "deepseek";
  if (mode === "mock") return { mode, model: mockModel };
  if (mode !== "deepseek")
    throw new Error("MODEL_MODE 只能是 deepseek 或 mock");
  const {
    DEEPSEEK_BASE_URL: baseURL,
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_MODEL: model,
  } = env;
  if (!apiKey?.trim())
    throw new Error(
      "请在 .env 中配置 DEEPSEEK_API_KEY；无密钥测试请显式设置 MODEL_MODE=mock",
    );
  const maxOutputTokens = Number(
    env.MODEL_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS,
  );
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw new Error("MODEL_MAX_OUTPUT_TOKENS 必须是正整数");
  return {
    mode,
    model: createDeepSeekModel({
      baseURL,
      apiKey: apiKey.trim(),
      model,
      maxOutputTokens,
    }),
  };
}
