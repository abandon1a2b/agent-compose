import { getImage } from "../../src/images.ts";
import { HttpError } from "../../src/types.ts";
import type { Publisher, Task } from "../../src/tasks/index.ts";
import type { Preset, Draft } from "../../src/tasks/presets.ts";

/** Local validation adapter. The core never imports the demo service or its storage. */
export class ContentServicePublisher implements Publisher {
  readonly mode = "local" as const;
  private base: string;
  constructor(base: string) {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      throw new Error("验证适配器只允许本机 HTTP 服务 origin");
    this.base = url.origin;
  }
  private async request(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(
        502,
        "本地内容服务不可用，请先启动 content-service-demo",
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new HttpError(502, "内容服务响应格式错误");
    }
    if (!response.ok)
      throw new HttpError(
        502,
        typeof data.error === "string"
          ? `内容服务：${data.error.slice(0, 200)}`
          : "内容提交失败",
      );
    return data;
  }
  async publish(
    preset: Preset,
    draft: Draft,
    subject: Task["subject"],
    idempotencyKey: string,
  ) {
    const kind =
      preset === "publish_case"
        ? "cases"
        : preset === "publish_article"
          ? "articles"
          : null;
    if (!kind) throw new HttpError(400, "内容服务不支持该任务");
    const payload: any = { ...draft, subject };
    if (kind === "cases") {
      payload.images = [];
      for (const reference of (draft.images ?? []) as string[]) {
        const url = new URL(reference);
        if (
          url.origin === this.base &&
          /^\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(url.pathname)
        ) {
          payload.images.push(url.href);
          continue;
        }
        if (
          !["127.0.0.1", "localhost"].includes(url.hostname) ||
          url.port !== (process.env.PORT ?? "4318") ||
          !/^\/images\/[a-zA-Z0-9-]+$/.test(url.pathname)
        )
          throw new HttpError(400, "本地验证请先上传图片，不接受外部图片URL");
        const image = getImage(url.pathname.split("/").at(-1)!);
        const asset = await this.request("/api/images", {
          method: "POST",
          headers: { "content-type": image.mime },
          body: new Uint8Array(image.bytes),
        });
        if (
          typeof asset.url !== "string" ||
          new URL(asset.url).origin !== this.base
        )
          throw new HttpError(502, "图片存储返回了错误地址");
        payload.images.push(asset.url);
      }
    }
    const record = await this.request(`/api/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    if (
      typeof record.id !== "string" ||
      typeof record.url !== "string" ||
      new URL(record.url).origin !== this.base
    )
      throw new HttpError(502, "发布结果格式错误");
    return {
      mock: false,
      publicationId: record.id,
      message: "已保存到本地内容验证服务，非线上发布",
      url: record.url,
    };
  }
}
