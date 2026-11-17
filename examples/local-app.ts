import { loadConfig } from "../src/config/index.ts";
import { contentExecutors } from "../integrations/content-service/executors.ts";
import { ContentServicePublisher } from "../integrations/content-service/publisher.ts";
import { Interactions } from "../src/interactions.ts";
import { TaskManager, MockPublisher } from "../src/tasks/index.ts";
import { createChatHandler } from "../src/chat.ts";
import { loadModel } from "../src/model.ts";
import { createHttpServer } from "../src/server.ts";
import { tools } from "../src/tools/index.ts";

const provider = process.env.CONTENT_SERVICE_URL
  ? new ContentServicePublisher(process.env.CONTENT_SERVICE_URL)
  : new MockPublisher();
const executors = contentExecutors(provider);
const config = loadConfig(
  process.env.HARNESS_RUNTIME_CONFIG ??
    new URL("../configs/runtime.json", import.meta.url),
  process.env.HARNESS_APPLICATION_CONFIG ??
    new URL("../configs/applications/decoration.json", import.meta.url),
  executors,
);
const { mode, model } = loadModel({
  ...process.env,
  MODEL_MAX_OUTPUT_TOKENS: String(
    config.runtime.compression.reservedOutputTokens,
  ),
});
const tasks = new TaskManager(
  {
    mode: "mode" in provider ? provider.mode : "mock",
    publish: (preset, draft, subject, key) => {
      const definition = config.application.presets.find(
        (p) => p.id === preset,
      )!;
      return executors[definition.executor].execute(
        preset,
        draft,
        subject,
        key,
      );
    },
  },
  config.application.presets,
  {
    switching: config.application.taskSwitching.enabled,
    configVersion: config.version,
    subject: config.application.subject,
  },
);
const interactions = new Interactions(config.runtime.interaction);
const server = createHttpServer(
  createChatHandler(
    model,
    tools,
    config.runtime.compression,
    tasks,
    interactions,
    { runtime: config.runtime, application: config.application },
  ),
  mode,
  tools,
  tasks,
  interactions,
  process.env.SERVE_DEMO_UI === "false"
    ? undefined
    : new URL("./chat-ui/", import.meta.url),
  config.runtime,
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
