import { FormValidationError } from "./form-interaction.ts";
import { uploadImage, getImage } from "./images.ts";
import type { Interactions } from "./interactions.ts";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import type { TaskManager, Preset } from "./tasks/index.ts";
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
  const { message, sessionId, compress, preset, stream, images } =
    value as Record<string, unknown>;
  if (
    typeof message !== "string" ||
    (!message.trim() && !(Array.isArray(images) && images.length)) ||
    message.length > 8000
  ) {
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
  if (
    preset !== undefined &&
    (typeof preset !== "string" || preset.length > 64)
  )
    throw new HttpError(400, "未知任务预设");
  if (stream !== undefined && typeof stream !== "boolean")
    throw new HttpError(400, "stream 必须是布尔值");
  if (
    images !== undefined &&
    (!Array.isArray(images) ||
      images.length > 4 ||
      images.some((x) => typeof x !== "string"))
  )
    throw new HttpError(400, "images 最多4个上传图片ID");
  return {
    images: images as string[] | undefined,
    stream: stream as boolean | undefined,
    message: message.trim() || "请查看这些图片",
    sessionId: sessionId as string | undefined,
    compress: compress as boolean | undefined,
    preset: preset as Preset | undefined,
  };
}

export function createHttpServer(
  chat: ChatHandler,
  modelMode: string,
  tools: Tool[] = [],
  tasks?: TaskManager,
  interactions?: Interactions,
  uiRoot?: URL,
  runtime: { requestTimeoutMs?: number } = {},
  uiPages?: ReadonlyMap<string, { contentType: string; read(): string }>,
) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const assets: Record<string, [string, string]> = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/interaction-ui.js": [
        "interaction-ui.js",
        "text/javascript; charset=utf-8",
      ],
      "/app.css": ["app.css", "text/css; charset=utf-8"],
      "/form-ui.js": ["form-ui.js", "text/javascript; charset=utf-8"],
    };
    const page = uiPages?.get(path);
    if (request.method === "GET" && uiRoot && (page || assets[path])) {
      try {
        const contentType = page?.contentType ?? assets[path][1];
        const body = page ? page.read() : readFileSync(new URL(assets[path][0], uiRoot));
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "no-cache",
        });
        response.end(body);
      } catch {
        json(response, 500, { error: "页面资源不可用" });
      }
      return;
    }
    if (request.method === "GET" && path === "/presets")
      return json(response, 200, tasks?.definitions ?? []);
    if (request.method === "GET" && path === "/health") {
      return json(response, 200, { status: "ok", modelMode });
    }
    if (request.method === "GET" && path === "/tools") {
      return json(
        response,
        200,
        (tasks?.forSession(
          new URL(request.url!, "http://localhost").searchParams.get(
            "sessionId",
          ) ?? "",
        )
          ? tasks.tools(
              new URL(request.url!, "http://localhost").searchParams.get(
                "sessionId",
              )!,
            )
          : tools
        ).map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      );
    }
    if (path === "/images" && request.method === "POST") {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new HttpError(413, "图片超过2MB");
          chunks.push(chunk);
        }
        return json(
          response,
          201,
          uploadImage(
            Buffer.concat(chunks),
            request.headers["content-type"]?.split(";")[0] ?? "",
            decodeURIComponent(
              String(request.headers["x-file-name"] ?? "image"),
            ),
          ),
        );
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 400, {
          error: error instanceof Error ? error.message : "上传失败",
        });
      }
    }
    const imageRoute = path.match(/^\/images\/([a-zA-Z0-9-]+)$/);
    if (imageRoute && request.method === "GET") {
      try {
        const image = getImage(imageRoute[1]);
        response.writeHead(200, {
          "content-type": image.mime,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        });
        response.end(image.bytes);
      } catch {
        json(response, 404, { error: "图片不存在" });
      }
      return;
    }
    const interactionRoute = path.match(
      /^\/interactions\/([a-zA-Z0-9-]+)\/(confirm|reply)$/,
    );
    if (
      interactionRoute &&
      request.method === "POST" &&
      interactions &&
      tasks
    ) {
      try {
        if (!request.headers["content-type"]?.startsWith("application/json"))
          throw new HttpError(415, "请使用JSON");
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65536) throw new HttpError(413, "请求过大");
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new HttpError(400, "JSON错误");
        }
        if (typeof body?.sessionId !== "string")
          throw new HttpError(400, "缺少sessionId");
        if (interactionRoute[2] === "reply") {
          const controller = new AbortController();
          response.on("close", () => {
            if (!response.writableEnded) controller.abort();
          });
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(runtime.requestTimeoutMs ?? 60000),
          ]);
          if (body.stream) {
            response.writeHead(200, {
              "content-type": "application/x-ndjson; charset=utf-8",
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            });
            response.flushHeaders();
            const emit = (event: unknown) => {
              if (response.destroyed || response.writableLength > 1048576) {
                controller.abort();
                response.destroy();
                signal.throwIfAborted();
              }
              response.write(JSON.stringify(event) + "\n");
            };
            try {
              emit({
                type: "done",
                result: await interactions.reply(
                  interactionRoute[1],
                  body.sessionId,
                  body.values,
                  body.requestId,
                  tasks,
                  chat,
                  signal,
                  emit,
                ),
              });
            } catch (error) {
              if (!response.destroyed)
                emit({
                  type: "error",
                  status: error instanceof HttpError ? error.status : 500,
                  message:
                    error instanceof HttpError ? error.message : "回复处理失败",
                  code: error instanceof HttpError ? error.code : undefined,
                  fieldErrors:
                    error instanceof FormValidationError
                      ? error.fieldErrors
                      : undefined,
                });
            } finally {
              response.end();
            }
            return;
          }
          return json(
            response,
            200,
            await interactions.reply(
              interactionRoute[1],
              body.sessionId,
              body.values,
              body.requestId,
              tasks,
              chat,
              signal,
            ),
          );
        }
        return json(
          response,
          200,
          await interactions.confirm(
            interactionRoute[1],
            body.sessionId,
            tasks,
          ),
        );
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : "确认失败",
          code: error instanceof HttpError ? error.code : undefined,
          fieldErrors:
            error instanceof FormValidationError
              ? error.fieldErrors
              : undefined,
        });
      }
    }
    const taskRoute = path.match(
      /^\/tasks\/([^/]+)(?:\/(draft|confirm|cancel))?$/,
    );
    if (tasks && taskRoute) {
      try {
        const [, id, action] = taskRoute;
        if (request.method === "GET" && !action) {
          const sessionId = new URL(
            request.url!,
            "http://localhost",
          ).searchParams.get("sessionId");
          if (!sessionId) throw new HttpError(400, "缺少 sessionId");
          return json(response, 200, tasks.get(id, sessionId));
        }
        if (request.method !== "POST" || !action)
          throw new HttpError(404, "接口不存在");
        if (!request.headers["content-type"]?.startsWith("application/json"))
          throw new HttpError(415, "请使用 application/json");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          chunks.push(chunk);
          size += chunk.length;
          if (size > 65536) throw new HttpError(413, "请求过大");
        }
        let data: any;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new HttpError(400, "JSON 格式错误");
        }
        if (!data || typeof data.sessionId !== "string")
          throw new HttpError(400, "缺少 sessionId");
        if (action === "cancel")
          return json(response, 200, tasks.cancel(id, data.sessionId));
        if (!Number.isSafeInteger(data.version))
          throw new HttpError(400, "缺少草稿版本");
        if (action === "draft")
          return json(
            response,
            200,
            tasks.update(id, data.sessionId, data.version, data.patch),
          );
        return json(
          response,
          200,
          await tasks.confirm(id, data.sessionId, data.version),
        );
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : "任务操作失败",
        });
      }
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
      AbortSignal.timeout(runtime.requestTimeoutMs ?? 60000),
    ]);
    try {
      const input = await readInput(request);
      if (input.stream) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        });
        response.flushHeaders();
        const emit = (event: unknown) => {
          if (response.destroyed || response.writableLength > 1024 * 1024) {
            disconnected.abort();
            response.destroy();
            signal.throwIfAborted();
          }
          response.write(JSON.stringify(event) + "\n");
        };
        try {
          const result = await chat(input, signal, emit);
          emit({ type: "done", result });
        } catch (error) {
          if (!response.destroyed)
            emit({
              type: "error",
              status: error instanceof HttpError ? error.status : 500,
              message: signal.aborted
                ? "请求已中断"
                : error instanceof HttpError
                  ? error.message
                  : "服务执行失败",
            });
        } finally {
          response.end();
        }
        return;
      }
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
