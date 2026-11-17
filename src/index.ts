import { createChatHandler } from "./chat.ts";
import { loadModel } from "./model.ts";
import { createHttpServer } from "./server.ts";
import { tools } from "./tools.ts";

const { mode, model } = loadModel();
const server = createHttpServer(createChatHandler(model, tools), mode);
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
