import { randomUUID } from "node:crypto";
import type { ContentPublisher } from "./contracts.ts";
import type { ExecutionResult } from "../../src/tasks/executor.ts";
export class MockContentPublisher implements ContentPublisher {
  readonly mode = "mock" as const;
  private results = new Map<string, ExecutionResult>();
  async publish(preset: string, _draft: unknown, _actor: unknown, key: string) {
    if (!this.results.has(key))
      this.results.set(key, {
        mock: true,
        publicationId: `mock-${preset}-${randomUUID()}`,
        message: "模拟发布成功，未写入任何真实业务系统",
      });
    return structuredClone(this.results.get(key)!);
  }
}
