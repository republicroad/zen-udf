import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { runDecisionTests } from "./fixtures.ts";
import { UdfRegistry } from "./register.ts";
import { createRuntimeExecutor } from "./runtime-executor.ts";

const model = {
  id: "g-adr015",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: {
        kind: "UDF",
        config: {
          expressions: [
            // 规范形信封（ADR-015 canonical）
            { id: "e1", key: "score", value: { $call: "score_udf", kwargs: { x: "x" } } },
            // legacy 平面形态（长期双读）
            { id: "e2", key: "scoreFlat", value: { $call: "score_udf", x: "x" } },
          ],
        },
      },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
};

const makeRuntime = (): { runtime: DecisionRuntime; registry: UdfRegistry } => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function score_udf(kwargs: Record<string, unknown>) {
      return { value: kwargs?.x ?? 0 };
    },
    "calc",
    {
      description: "score udf",
      parametersSchema: {
        type: "object",
        properties: { x: { type: "integer", title: "X" } },
        required: ["x"],
      },
    },
  );
  return { runtime: new DecisionRuntime({ registry }), registry };
};

describe("ADR-015 调用规范（具名字典 + 双读）", () => {
  test("规范形信封 {$call, kwargs} 与 legacy 平面形态执行等价", async () => {
    const { runtime } = makeRuntime();
    await runWithExecContext({ tenantId: "t" }, async () => {
      runtime.createDecisionWithCacheKey("k", model, "v1");
      const outcome = await runtime.evaluateAsync("k", { x: 7 }, undefined, "v1");
      // 两形态同图并存：信封形（kwargs 值为表达式串按 nodeInput 求值）与
      // 平面形（除 $call 外键即参数）产出一致
      expect(outcome.result).toMatchObject({ score: { value: 7 }, scoreFlat: { value: 7 } });
    });
  });

  test("信封优先规则：kwargs 键为 Record 时按信封解释（歧义形态迁移规范形即消除）", async () => {
    const { runtime, registry } = makeRuntime();
    // 名为 kwargs 的参数：仅平面形态可表达——信封胜出后它无法经信封传递
    registry.registerFunction(
      function special_udf(kwargs: Record<string, unknown>) {
        return { got: kwargs };
      },
      "calc",
      {
        parametersSchema: {
          type: "object",
          properties: { kwargs: { type: "object", title: "Kwargs" } },
        },
      },
    );
    await runWithExecContext({ tenantId: "t" }, async () => {
      runtime.createDecisionWithCacheKey(
        "k-env",
        {
          id: "g-env",
          nodes: [
            { id: "in", type: "inputNode", name: "Request" },
            {
              id: "c1",
              type: "customNode",
              name: "custom",
              content: {
                kind: "UDF",
                config: {
                  expressions: [
                    // 信封解读：kwargs 的值整体成为实参（inner 对声明的 kwargs 参数是未声明键）
                    { id: "e1", key: "v", value: { $call: "special_udf", kwargs: { inner: 1 } } },
                  ],
                },
              },
            },
            { id: "out", type: "outputNode", name: "Response" },
          ],
          edges: [
            { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
            { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
          ],
        },
        "v1",
      );
      const outcome = await runtime.evaluateAsync("k-env", {}, undefined, "v1");
      // 信封胜出的证据：inner 被当作具名实参（对声明的 kwargs 参数是未知键）→
      // bindNamedArgs 防笔误报 INVALID_PARAM；平面解读则会成功绑定 kwargs 参数
      const v = (outcome.result as { v?: { error?: { code?: string; issues?: string[] } } }).v;
      expect(v?.error?.code).toBe("INVALID_PARAM");
      expect(JSON.stringify(v?.error?.issues)).toContain("inner");
    });
  });
});

describe("ADR-015 normalizeNamedCall（三形态归一，结构归一值不造）", () => {
  const schema = {
    type: "object",
    properties: { base: { type: "integer" }, income: { type: "number" } },
  };

  test("位置数组按 properties 键序映射为具名", () => {
    expect(DecisionRuntime.normalizeNamedCall(["credit", 600, 8], schema)).toEqual({
      $call: "credit",
      kwargs: { base: 600, income: 8 },
    });
  });

  test("超出声明位的多余位置值收进保留键 $positional（漂移带按 extra 检出）", () => {
    expect(DecisionRuntime.normalizeNamedCall(["credit", 600, 8, true, "x"], schema)).toEqual({
      $call: "credit",
      kwargs: { base: 600, income: 8, $positional: [true, "x"] },
    });
  });

  test("无 schema 可依时全部位置值进 $positional（键不造）", () => {
    expect(DecisionRuntime.normalizeNamedCall(["credit", 600, 8])).toEqual({
      $call: "credit",
      kwargs: { $positional: [600, 8] },
    });
  });

  test("具名对象透传收编（信封形与平面形）", () => {
    expect(DecisionRuntime.normalizeNamedCall({ $call: "f", kwargs: { a: 1 } })).toEqual({
      $call: "f",
      kwargs: { a: 1 },
    });
    expect(DecisionRuntime.normalizeNamedCall({ $call: "f", a: 1, b: 2 })).toEqual({
      $call: "f",
      kwargs: { a: 1, b: 2 },
    });
  });

  test("无 $call 的对象与不可解析输入返回 null", () => {
    expect(DecisionRuntime.normalizeNamedCall({ foo: 1 }, schema)).toBeNull();
    expect(DecisionRuntime.normalizeNamedCall(null, schema)).toBeNull();
  });
});

describe("ADR-015 validateNamedArgs（按名校验三类清单）", () => {
  test("missing / extra / typeMismatch 三类与编辑面漂移带同构", () => {
    const { registry } = makeRuntime();
    const drift = registry.validateNamedArgs("score_udf", { x: "not-int", ghost: 1 });
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual(["ghost"]);
    expect(drift.typeMismatch).toEqual([{ name: "x", expected: "integer", actual: "string" }]);
  });

  test("缺必填 + 全通过两极", () => {
    const { registry } = makeRuntime();
    expect(registry.validateNamedArgs("score_udf", {}).missing).toEqual(["x"]);
    const ok = registry.validateNamedArgs("score_udf", { x: 3 });
    expect(ok).toEqual({ missing: [], extra: [], typeMismatch: [] });
  });

  test("未注册函数返回空清单（与位置校验同款宽容）", () => {
    const { registry } = makeRuntime();
    expect(registry.validateNamedArgs("nope", { a: 1 })).toEqual({ missing: [], extra: [], typeMismatch: [] });
  });

  test("executor 契约端到端：normalizeNamedCall 归一后的夹具经 runner 全通过", async () => {
    const { runtime } = makeRuntime();
    const schema = { type: "object", properties: { x: { type: "integer" } } };
    const normalized = DecisionRuntime.normalizeNamedCall(["score_udf", 4], schema);
    expect(normalized).toEqual({ $call: "score_udf", kwargs: { x: 4 } });
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "adr015", model, rev: "v1" }),
      fixtures: [
        {
          name: "归一后执行",
          input: { x: 4, flagged: false },
          expect: { mode: "path", path: "score.value", value: 4 },
        },
      ],
    });
    expect(report.failed).toBe(0);
  });
});

describe("ADR-015 平面 kwargs 歧义检测（detectKwargsEnvelopeAmbiguity）", () => {
  const schemaWithKwargs = {
    type: "object",
    properties: { kwargs: { type: "object", title: "Kwargs" } },
  };
  const schemaNormal = { type: "object", properties: { x: { type: "integer" } } };

  test("kwargs Record + 声明 kwargs 参数 → 歧义（作者平面意图无法表达）", () => {
    expect(DecisionRuntime.detectKwargsEnvelopeAmbiguity({ $call: "f", kwargs: { inner: 1 } }, schemaWithKwargs)).toBe(
      true,
    );
  });

  test("未声明 kwargs 参数 / 非信封形态 → 无歧义", () => {
    expect(DecisionRuntime.detectKwargsEnvelopeAmbiguity({ $call: "f", kwargs: { inner: 1 } }, schemaNormal)).toBe(
      false,
    );
    expect(DecisionRuntime.detectKwargsEnvelopeAmbiguity({ $call: "f", x: 1 }, schemaWithKwargs)).toBe(false);
    expect(DecisionRuntime.detectKwargsEnvelopeAmbiguity(["f", 1], schemaWithKwargs)).toBe(false);
    expect(DecisionRuntime.detectKwargsEnvelopeAmbiguity(null, schemaWithKwargs)).toBe(false);
  });
});
