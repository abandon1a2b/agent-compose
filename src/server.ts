import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  HttpError,
  type ChatHandler,
  type ChatInput,
  type Tool,
} from "./types.ts";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readInput(request: IncomingMessage): Promise<ChatInput> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "请使用 application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求体超过 64KB");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
  if (!value || typeof value !== "object")
    throw new HttpError(400, "请求必须是对象");
  const { message, sessionId, compress } = value as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim() || message.length > 8000) {
    throw new HttpError(400, "message 必须是 1–8000 字符的文本");
  }
  if (
    sessionId !== undefined &&
    (typeof sessionId !== "string" || !sessionId || sessionId.length > 100)
  ) {
    throw new HttpError(400, "sessionId 格式错误");
  }
  if (compress !== undefined && typeof compress !== "boolean")
    throw new HttpError(400, "compress 必须是布尔值");
  return {
    message: message.trim(),
    sessionId: sessionId as string | undefined,
    compress: compress as boolean | undefined,
  };
}

export function createHttpServer(
  chat: ChatHandler,
  modelMode: string,
  tools: Tool[] = [],
) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/health") {
      return json(response, 200, { status: "ok", modelMode });
    }
    if (request.method === "GET" && path === "/tools") {
      return json(
        response,
        200,
        tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      );
    }
    if (request.method !== "POST" || path !== "/chat") {
      return json(response, 404, { error: "接口不存在" });
    }
    const disconnected = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) disconnected.abort();
    });
    const signal = AbortSignal.any([
      disconnected.signal,
      AbortSignal.timeout(60_000),
    ]);
    try {
      const input = await readInput(request);
      const output = await chat(input, signal);
      if (!response.destroyed) json(response, 200, output);
    } catch (error) {
      if (response.destroyed) return;
      if (signal.aborted)
        return json(response, 504, { error: "请求已超时或中断" });
      const status = error instanceof HttpError ? error.status : 500;
      json(response, status, {
        error: error instanceof HttpError ? error.message : "服务执行失败",
      });
    }
  });
}
