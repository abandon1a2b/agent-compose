import type { Tool } from "./types.ts";

export const tools: Tool[] = [
  {
    name: "get_current_time",
    description: "获取当前 UTC 时间，用于回答现在几点等问题。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length
      ) {
        throw new Error("get_current_time 参数必须是空对象 {}");
      }
      return { utc: new Date().toISOString() };
    },
  },
];
