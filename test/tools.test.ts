import test from "node:test";
import assert from "node:assert/strict";
import { createToolExecutor } from "../src/tool-executor.ts";
import { tools } from "../src/tools/index.ts";
import { runLoop } from "../src/loop.ts";
import type { Model } from "../src/types.ts";
const signal = () => AbortSignal.timeout(5000);
test("registered calculation validates arguments and reports errors as observations", async () => {
  const execute = createToolExecutor(tools);
  const call = (input: unknown) =>
    execute(
      { id: "x", name: "calculate", arguments: JSON.stringify(input) },
      signal(),
    );
  assert.deepEqual(await call({ operation: "multiply", a: 137, b: 29 }), {
    ok: true,
    value: { result: 3973 },
  });
  for (const input of [
    { operation: "divide", a: 1, b: 0 },
    { operation: "add", a: "1", b: 2 },
    { operation: "eval", a: 1, b: 2 },
  ])
    assert.equal((await call(input)).ok, false);
  assert.equal(
    (
      await execute(
        { id: "x", name: "unregistered", arguments: "{}" },
        signal(),
      )
    ).ok,
    false,
  );
  assert.throws(() => createToolExecutor([tools[0], tools[0]]), /重复/);
});
test("dependent tool calls use the previous result in the next model turn", async () => {
  let step = 0;
  const model: Model = {
    async complete(messages) {
      step++;
      if (step === 3)
        return { role: "assistant", content: messages.at(-1)!.content };
      const a =
        step === 1 ? 137 : JSON.parse(messages.at(-1)!.content).value.result;
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call-${step}`,
            name: "calculate",
            arguments: JSON.stringify({
              operation: step === 1 ? "multiply" : "add",
              a,
              b: step === 1 ? 29 : 41,
            }),
          },
        ],
      };
    },
  };
  const result = await runLoop(
    model,
    tools,
    [{ role: "user", content: "计算137*29+41" }],
    signal(),
  );
  assert.equal(result.modelCalls, 3);
  assert.equal(JSON.parse(result.reply).value.result, 4014);
  assert.equal(result.toolCalls.length, 2);
});
