import { readFileSync } from "node:fs";
import type { TaskDefinition } from "../../src/tasks/presets.ts";
/** Compatibility export for existing adapter tests; production uses validated loadConfig. */
export const presets: TaskDefinition[] = JSON.parse(
  readFileSync(
    new URL("../../configs/applications/decoration.json", import.meta.url),
    "utf8",
  ),
).presets;
