import type { TaskExecutor } from "../../src/tasks/executor.ts";
export interface ContentPublisher {
  mode?: "local" | "mock";
  publish: TaskExecutor["execute"];
}
