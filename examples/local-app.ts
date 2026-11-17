import { presets } from "../integrations/content-service/presets.ts";
import { ContentServicePublisher } from "../integrations/content-service/publisher.ts";
import { Interactions } from "../src/interactions.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { createChatHandler } from "../src/chat.ts";
import { loadModel } from "../src/model.ts";
import { createHttpServer } from "../src/server.ts";
import { tools } from "../src/tools/index.ts";
import { loadCompressionPolicy } from "../src/compression.ts";

const { mode, model } = loadModel();
const tasks = new TaskManager(
  process.env.CONTENT_SERVICE_URL
    ? new ContentServicePublisher(process.env.CONTENT_SERVICE_URL)
    : undefined,
  presets,
);
const interactions = new Interactions();
const server = createHttpServer(
  createChatHandler(model, tools, loadCompressionPolicy(), tasks, interactions),
  mode,
  tools,
  tasks,
  interactions,
  process.env.SERVE_DEMO_UI === "false"
    ? undefined
    : new URL("./chat-ui/", import.meta.url),
);
const port = Number(process.env.PORT ?? 4318);
server.listen(port, "127.0.0.1", () => {
  console.log(`Agent Harness · http://127.0.0.1:${port} · model=${mode}`);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
const shutdown = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
