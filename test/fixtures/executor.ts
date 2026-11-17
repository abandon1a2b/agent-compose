import { MockContentPublisher } from "../../integrations/content-service/mock-publisher.ts";
import type { TaskExecutor } from "../../src/tasks/executor.ts";
export function mockExecutor(): TaskExecutor {
  const publisher = new MockContentPublisher();
  return {
    target: { label: "测试执行器", simulated: true },
    requiresConfirmation: () => true,
    execute: publisher.publish.bind(publisher),
  };
}
