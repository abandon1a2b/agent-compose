import { presets } from "../integrations/content-service/presets.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { uploadImage, resolveImages, getImage } from "../src/images.ts";
import { Interactions } from "../src/interactions.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { createChatHandler } from "../src/chat.ts";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCxoAAAAASUVORK5CYII=",
  "base64",
);
test("image upload restricts MIME and size; references resolve to multimodal data", () => {
  const asset = uploadImage(png, "image/png", "demo.png");
  const image = resolveImages([asset.id])[0];
  assert.match(image.url, /^data:image\/png;base64,/);
  assert.equal(getImage(asset.id).bytes.equals(png), true);
  assert.throws(
    () => uploadImage(Buffer.from("<svg/>"), "image/svg+xml", "x"),
    /只支持/,
  );
  assert.throws(
    () => uploadImage(Buffer.alloc(3 * 1024 * 1024), "image/png", "x"),
    /上限/,
  );
  assert.throws(() => resolveImages(["unknown"]), /不存在/);
});
test("model sees attached image instead of only a filename", async () => {
  const asset = uploadImage(png, "image/png", "demo.png");
  let seen = false;
  const chat = createChatHandler(
    {
      async complete(messages) {
        seen = !!messages.at(-1)?.images?.[0].url.startsWith("data:image/png");
        return { role: "assistant", content: "图片已收到" };
      },
    },
    [],
  );
  await chat(
    { message: "看图片", images: [asset.id] },
    AbortSignal.timeout(3000),
  );
  assert.equal(seen, true);
});
test("model-generated interaction rejects code and arbitrary action properties", async () => {
  const ui = new Interactions(),
    tasks = new TaskManager(undefined, presets),
    cards: any[] = [];
  const tool = ui.tools("s", tasks, (c) => cards.push(c))[0];
  assert.throws(
    () =>
      tool.execute(
        { kind: "html", title: "x", html: "<script>" },
        new AbortController().signal,
      ),
    /不合法/,
  );
  assert.throws(
    () =>
      tool.execute(
        { kind: "question", title: "x", action: "https://evil.example" },
        new AbortController().signal,
      ),
    /不合法/,
  );
  await tool.execute(
    { kind: "question", title: "请选择风格", options: ["原木", "现代"] },
    new AbortController().signal,
  );
  assert.equal(cards[0].title, "请选择风格");
  assert.equal(cards[0].kind, "question");
});
test("confirmation card binds real snapshot, rejects stale revision and cannot cross sessions", async () => {
  const tasks = new TaskManager(undefined, presets),
    ui = new Interactions(),
    cards: any[] = [];
  const task = tasks.ensure("s", "publish_article")!;
  const tool = ui.tools("s", tasks, (c) => cards.push(c))[0];
  assert.throws(
    () =>
      tool.execute(
        { kind: "confirmation", title: "发布" },
        new AbortController().signal,
      ),
    /未准备/,
  );
  tasks.update(task.id, "s", 0, { title: "真实标题", content: "真实正文" });
  await tool.execute(
    { kind: "confirmation", title: "请确认" },
    new AbortController().signal,
  );
  assert.equal(cards[0].snapshot.draft.title, "真实标题");
  assert.equal(tasks.get(task.id, "s").status, "awaiting_confirmation");
  await assert.rejects(ui.confirm(cards[0].id, "other", tasks), /不存在/);
  tasks.update(task.id, "s", 1, { title: "新标题" });
  await assert.rejects(ui.confirm(cards[0].id, "s", tasks), /过期/);
  await tool.execute(
    { kind: "confirmation", title: "再次确认" },
    new AbortController().signal,
  );
  const result = await ui.confirm(cards[1].id, "s", tasks);
  assert.equal(result.result?.mock, true);
  assert.equal(
    (await ui.confirm(cards[1].id, "s", tasks)).result?.publicationId,
    result.result?.publicationId,
  );
});

test("visible text before a tool call is retained alongside the final response", async () => {
  let step = 0;
  const chat = createChatHandler(
    {
      async complete() {
        step++;
        return step === 1
          ? {
              role: "assistant",
              content: "图片主要是红色。",
              toolCalls: [
                {
                  id: "q",
                  name: "render_interaction",
                  arguments: JSON.stringify({
                    kind: "question",
                    title: "选择风格",
                    options: ["原木"],
                  }),
                },
              ],
            }
          : { role: "assistant", content: "请选择偏好。" };
      },
    },
    [],
  );
  const result = await chat(
    { message: "描述图片并询问偏好" },
    AbortSignal.timeout(3000),
  );
  assert.deepEqual(result.textParts, ["图片主要是红色。", "请选择偏好。"]);
  assert.equal(result.interactions?.length, 1);
});
