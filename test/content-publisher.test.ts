import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ContentServicePublisher } from "../integrations/content-service/publisher.ts";
import { uploadImage } from "../src/images.ts";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCxoAAAAASUVORK5CYII=",
  "base64",
);
test("HTTP adapter copies image bytes and sends version idempotency key", async () => {
  let origin = "",
    uploaded = false,
    posted: any;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/images") {
      assert.equal(bytes.equals(png), true);
      uploaded = true;
      res.end(
        JSON.stringify({ url: origin + "/media/" + "a".repeat(64) + ".png" }),
      );
    } else {
      posted = JSON.parse(bytes.toString());
      assert.equal(req.headers["idempotency-key"], "task:2:subject");
      res.end(
        JSON.stringify({
          id: "local-id",
          url: origin + "/?kind=cases&id=local-id",
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const image = uploadImage(png, "image/png", "test");
    const result = await new ContentServicePublisher(origin).publish(
      "publish_case",
      {
        title: "t",
        content: "c",
        city: "上海",
        area: 90,
        images: [`http://127.0.0.1:4318/images/${image.id}`],
      },
      { id: "subject", name: "验证主体" },
      "task:2:subject",
    );
    assert.equal(uploaded, true);
    assert.ok(posted.images[0].startsWith(origin));
    assert.equal(result.mock, false);
    assert.equal(result.publicationId, "local-id");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
test("local adapter refuses non-local service targets", () => {
  assert.throws(
    () => new ContentServicePublisher("https://example.com"),
    /本机/,
  );
});
