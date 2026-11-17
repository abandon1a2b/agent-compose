import type { Tool } from "../types.ts";

export const calculate: Tool = {
  name: "calculate",
  description:
    "执行两个有限数字的加、减、乘、除，使用 JavaScript 双精度数值，不用于精确货币结算。",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
      },
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["operation", "a", "b"],
    additionalProperties: false,
  },
  execute(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("参数必须是对象");
    const { operation, a, b } = input as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["operation", "a", "b"].includes(key))
    )
      throw new Error("存在未知参数");
    if (
      typeof a !== "number" ||
      typeof b !== "number" ||
      !Number.isFinite(a) ||
      !Number.isFinite(b)
    )
      throw new Error("a、b 必须是有限数字");
    let result: number;
    switch (operation) {
      case "add":
        result = a + b;
        break;
      case "subtract":
        result = a - b;
        break;
      case "multiply":
        result = a * b;
        break;
      case "divide":
        if (b === 0) throw new Error("除数不能为零");
        result = a / b;
        break;
      default:
        throw new Error("不支持该运算");
    }
    if (!Number.isFinite(result)) throw new Error("计算结果超出有限数值范围");
    return { result };
  },
};
