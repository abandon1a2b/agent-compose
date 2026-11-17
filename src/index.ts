import { Interactions } from "./interactions.ts";
import { TaskManager } from "./tasks/index.ts";
import { createChatHandler } from "./chat.ts";
import { loadModel } from "./model.ts";
import { createHttpServer } from "./server.ts";
import { tools } from "./tools/index.ts";
import { loadCompressionPolicy } from "./compression.ts";

const { mode, model } = loadModel();
const tasks = new TaskManager();
const interactions = new Interactions();
const server = createHttpServer(
  createChatHandler(model, tools, loadCompressionPolicy(), tasks, interactions),
  mode,
  tools,
  tasks,
  interactions,
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
