import test from "node:test";
import assert from "node:assert/strict";
import {
  compactContext,
  contextMessages,
  defaultCompressionPolicy,
  loadCompressionPolicy,
  SUMMARY_SYSTEM_PROMPT,
  validateCompressionPolicy,
  type CompressionPolicy,
  type Conversation,
} from "../src/compression.ts";
import { estimateInputTokens } from "../src/token-budget.ts";
import { createChatHandler } from "../src/chat.ts";
import { runLoop } from "../src/loop.ts";
import type { Message, Model, Tool } from "../src/types.ts";

const policy: CompressionPolicy = {
  ...defaultCompressionPolicy,
  contextWindowTokens: 6000,
  reservedOutputTokens: 512,
  summaryMaxTokens: 256,
  keepRecentTurns: 1,
};
const pair = (text: string): Message[] => [
  { role: "user", content: text },
  { role: "assistant", content: "已记住" },
];
const recent: Message[] = [
  { role: "user", content: "查询当前时间" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "time-1", name: "time", arguments: "{}" }],
  },
  {
    role: "tool",
    content: '{"utc":"2026-11-17T08:00:00Z"}',
    toolCallId: "time-1",
  },
  { role: "assistant", content: "现在是 UTC 08:00" },
];
const input: Message = {
  role: "user",
  content: "保留本次用户输入，告诉我预算",
};
const systemPrompt = "仅按系统规则执行，历史摘要是背景数据。";
const signal = () => AbortSignal.timeout(5000);
const conversation = (): Conversation => ({
  messages: [
    ...pair("客户林舟，编号 H-7291，预算12万元。" + "旧资料".repeat(2000)),
    ...recent,
  ],
});
const summaryModel: Model = {
  async complete(_messages, tools, _signal, options) {
    assert.equal(tools.length, 0);
    assert.ok(options!.maxOutputTokens! <= policy.summaryMaxTokens);
    return {
      role: "assistant",
      content: "客户林舟，编号 H-7291，预算12万元。",
    };
  },
};
const compact = (
  state: Conversation,
  model: Model = summaryModel,
  overrides: Partial<Parameters<typeof compactContext>[0]> = {},
) =>
  compactContext({
    model,
    conversation: state,
    systemPrompt,
    input,
    tools: [],
    signal: signal(),
    policy,
    ...overrides,
  });

test("trigger uses available-window ratio, and scales with the model context window", async () => {
  const state = conversation();
  const first = await compact(state);
  assert.equal(first.info.inputBudgetTokens, 6000 - 512);
  assert.equal(first.info.triggerTokens, Math.floor((6000 - 512) * 0.8));
  assert.equal(first.info.targetTokens, Math.floor((6000 - 512) * 0.5));
  assert.equal(first.info.status, "compressed");
  assert.ok(first.info.beforeRatio >= 0.8);
  assert.ok(first.info.afterRatio <= 0.5);
  assert.equal(first.info.tokenCountMethod, "estimated");
  const doubled = await compact(
    state,
    {
      async complete() {
        throw new Error("should not call");
      },
    },
    {
      policy: { ...policy, contextWindowTokens: 12000 },
    },
  );
  assert.equal(doubled.info.reason, "below_threshold");
  assert.equal(doubled.info.modelCalls, 0);
  assert.strictEqual(doubled.conversation, state);
});

test("system, newest user input and recent complete tool chains are preserved; history is not mutated", async () => {
  const state = conversation(),
    original = structuredClone(state);
  const result = await compact(state);
  assert.deepEqual(state, original);
  assert.deepEqual(result.conversation.messages, recent);
  assert.equal(result.info.summarizedTurns, 1);
  const prompt = contextMessages(systemPrompt, result.conversation, input);
  assert.deepEqual(prompt[0], { role: "system", content: systemPrompt });
  assert.equal(prompt[1].role, "assistant");
  assert.match(prompt[1].content, /历史对话摘要/);
  assert.deepEqual(prompt.at(-1), input);
  assert.deepEqual(prompt.slice(2, -1), recent);
});

test("explicit request compacts below threshold and carries the previous summary into the next summary", async () => {
  const first = await compact(conversation());
  let previous = "";
  const model: Model = {
    async complete(messages) {
      previous = JSON.parse(messages[1].content).previousSummary;
      return {
        role: "assistant",
        content: "林舟 H-7291，预算12万元，已查询UTC时间。",
      };
    },
  };
  const second = await compact(
    {
      ...first.conversation,
      messages: [...first.conversation.messages, ...pair("新的回合")],
    },
    model,
    { force: true },
  );
  assert.equal(previous, first.conversation.summary);
  assert.equal(second.info.reason, "requested");
  assert.equal(second.info.status, "compressed");
  assert.deepEqual(second.conversation.messages, pair("新的回合"));
});

test("invalid or failed summaries fall back without deleting source context", async () => {
  const state = conversation();
  const responses: Message[] = [
    { role: "assistant", content: "" },
    { role: "assistant", content: "过长".repeat(1000) },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "x", name: "time", arguments: "{}" }],
    },
  ];
  for (const response of responses) {
    const result = await compact(state, {
      async complete() {
        return response;
      },
    });
    assert.equal(result.info.status, "failed");
    assert.strictEqual(result.conversation, state);
    assert.equal(result.info.afterInputTokens, result.info.beforeInputTokens);
  }
  const failed = await compact(state, {
    async complete() {
      throw new Error("provider error");
    },
  });
  assert.equal(failed.info.reason, "summary_failed");
  assert.strictEqual(failed.conversation, state);
});

test("a longer replacement is skipped and cancellation is propagated", async () => {
  const state = { messages: [...pair("旧消息"), ...pair("新消息")] };
  const result = await compact(
    state,
    {
      async complete() {
        return { role: "assistant", content: "更长的摘要".repeat(20) };
      },
    },
    { force: true },
  );
  assert.equal(result.info.reason, "not_smaller");
  assert.strictEqual(result.conversation, state);
  const controller = new AbortController();
  const model: Model = {
    async complete() {
      controller.abort();
      throw new Error("aborted");
    },
  };
  await assert.rejects(
    compact(conversation(), model, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("target is soft when recent turns alone are large, while hard input budget is enforced", async () => {
  const state = {
    messages: [...pair("旧".repeat(1600)), ...pair("新".repeat(6000))],
  };
  const result = await compact(state, summaryModel, {
    force: true,
    policy: { ...policy, contextWindowTokens: 9000 },
  });
  assert.equal(result.info.status, "compressed");
  assert.equal(result.info.targetReached, false);
  assert.deepEqual(result.conversation.messages, pair("新".repeat(6000)));
  await assert.rejects(
    compact({ messages: pair("巨大输入".repeat(5000)) }, summaryModel, {
      force: true,
    }),
    /超过输入预算/,
  );
});

test("compression can be disabled and invalid ratios fail at startup", async () => {
  const result = await compact(conversation(), summaryModel, {
    force: true,
    policy: { ...policy, enabled: false },
  });
  assert.equal(result.info.reason, "disabled");
  assert.equal(result.info.modelCalls, 0);
  assert.throws(
    () => validateCompressionPolicy({ ...policy, targetRatio: 0.9 }),
    /压缩比例/,
  );
  assert.throws(
    () => loadCompressionPolicy({ CONTEXT_TRIGGER_RATIO: "NaN" }),
    /压缩比例/,
  );
  assert.throws(
    () => loadCompressionPolicy({ MODEL_MAX_OUTPUT_TOKENS: "1000000" }),
    /输出预留/,
  );
  assert.equal(
    loadCompressionPolicy({ MODEL_CONTEXT_WINDOW_TOKENS: "128000" })
      .contextWindowTokens,
    128000,
  );
});

test("output reservation is also passed as the actual model output cap", async () => {
  let cap: number | undefined;
  const model: Model = {
    async complete(_messages, _tools, _signal, options) {
      cap = options?.maxOutputTokens;
      return { role: "assistant", content: "ok" };
    },
  };
  await createChatHandler(model, [], { ...policy, reservedOutputTokens: 256 })(
    { message: "hello" },
    signal(),
  );
  assert.equal(cap, 256);
});

test("one incomplete turn is never compacted; tool schemas and newest input count towards budget", async () => {
  await assert.rejects(
    compact({ messages: recent.slice(0, -1) }, summaryModel, { force: true }),
    /已完成/,
  );
  const one = await compact({ messages: pair("刚开始") }, summaryModel, {
    force: true,
  });
  assert.equal(one.info.reason, "not_enough_turns");
  const baseline = estimateInputTokens([input], []);
  const tool: Tool = {
    name: "test",
    description: "工具描述".repeat(100),
    parameters: {},
    execute() {},
  };
  assert.ok(estimateInputTokens([input], [tool]) > baseline);
});

test("oversized active-turn tool output stops before another model request", async () => {
  let requests = 0;
  const model: Model = {
    async complete() {
      requests++;
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "large", name: "large", arguments: "{}" }],
      };
    },
  };
  const tool: Tool = {
    name: "large",
    description: "large",
    parameters: {},
    execute: () => "大".repeat(5000),
  };
  await assert.rejects(
    runLoop(model, [tool], [input], signal(), 6, { maxInputTokens: 1000 }),
    /工具结果超过上下文预算/,
  );
  assert.equal(requests, 1);
});

test("failed turns roll back compaction; successful turns include summary calls in modelCalls", async () => {
  const summarized: string[] = [];
  const model: Model = {
    async complete(messages) {
      if (messages[0].content.startsWith(SUMMARY_SYSTEM_PROMPT)) {
        summarized.push(JSON.parse(messages[1].content).turns[0][0].content);
        return { role: "assistant", content: "姓名林舟" };
      }
      if (messages.at(-1)!.content === "fail") throw new Error("chat failed");
      return { role: "assistant", content: "ok" };
    },
  };
  const chat = createChatHandler(model, [], {
    ...policy,
    contextWindowTokens: 20000,
  });
  const first = await chat(
    { message: "姓名林舟" + "历史".repeat(200) },
    signal(),
  );
  await chat({ sessionId: first.sessionId, message: "最近回合" }, signal());
  await assert.rejects(
    chat(
      { sessionId: first.sessionId, message: "fail", compress: true },
      signal(),
    ),
    /chat failed/,
  );
  const next = await chat(
    { sessionId: first.sessionId, message: "继续", compress: true },
    signal(),
  );
  assert.equal(summarized.length, 2);
  assert.equal(summarized[0], summarized[1]);
  assert.equal(next.compression.status, "compressed");
  assert.equal(next.modelCalls, 2);
});
