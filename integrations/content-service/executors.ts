import type { ContentPublisher } from "./contracts.ts";
import type { ExecutorBinding } from "../../src/config/index.ts";
export function contentExecutors(
  publisher: ContentPublisher,
): Record<string, ExecutorBinding> {
  return {
    "content.publishCase": {
      requiresConfirmation: true,
      execute: (_preset, draft, subject, key) =>
        publisher.publish("publish_case", draft, subject, key),
    },
    "content.publishArticle": {
      requiresConfirmation: true,
      execute: (_preset, draft, subject, key) =>
        publisher.publish("publish_article", draft, subject, key),
    },
  };
}
