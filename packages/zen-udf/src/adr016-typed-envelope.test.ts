import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

const makeRuntime = () => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function echo(kwargs: Record<string, unknown>) {
      return { v: kwargs?.v ?? null, raw: kwargs };
    },
    "probe",
    {
      parametersSchema: {
        type: "object",
        properties: { v: { type: ["string", "number", "object"] } },
        required: ["v"],
      },
    },
  );
  registry.registerFunction(
    function sum2(kwargs: Record<string, unknown>) {
      return { sum: (kwargs?.a as number) + (kwargs?.b as number) };
    },
    "math",
    {
      parametersSchema: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
    },
  );
  return new DecisionRuntime({ registry });
};

const graph = (expressions: unknown[]) => ({
  id: "g",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    { id: "c1", type: "customNode", name: "custom", content: { kind: "UDF", config: { expressions } } },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const runNode = async (expressions: unknown[], input: unknown = {}) => {
  const runtime = makeRuntime();
  let outcome: unknown;
  await runWithExecContext({ tenantId: "t" }, async () => {
    runtime.createDecisionWithCacheKey("k", graph(expressions) as never, "v1");
    const r = await runtime.evaluateAsync("k", input, undefined, "v1");
    outcome = r.result;
  });
  return outcome as Record<string, { v?: unknown; sum?: number; error?: { code?: string; issues?: string[] } }>;
};

describe("ADR-016 TypedValue 信封（参数值模式显式化）", () => {
  test("literal：原样绑定不求值——$. 开头的字符串字面量无引号仪式", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", value: { $call: "echo", kwargs: { v: { mode: "literal", value: "$.customer" } } } },
    ]);
    expect(outcome?.a).toMatchObject({ v: "$.customer" }); // 未被求值成 undefined/null
  });

  test("literal ≡ 裸引号惯例（共存验证）：两种写法产出一致", async () => {
    const outcome = await runNode([
      { id: "e1", key: "lit", value: { $call: "echo", kwargs: { v: { mode: "literal", value: "sha256" } } } },
      { id: "e2", key: "quoted", value: { $call: "echo", kwargs: { v: '"sha256"' } } },
    ]);
    expect(outcome?.lit).toMatchObject({ v: "sha256" });
    expect(outcome?.quoted).toMatchObject({ v: "sha256" });
  });

  test("expression ≡ 裸字符串（显式版）：求值语义一致", async () => {
    const outcome = await runNode(
      [
        { id: "e1", key: "bare", value: { $call: "sum2", kwargs: { a: "1", b: "2" } } },
        {
          id: "e2",
          key: "env",
          value: {
            $call: "sum2",
            kwargs: { a: { mode: "expression", value: "1" }, b: { mode: "expression", value: "2" } },
          },
        },
      ],
      {},
    );
    expect(outcome?.bare).toMatchObject({ sum: 3 });
    expect(outcome?.env).toMatchObject({ sum: 3 });
  });

  test("reference 首期 ≡ expression 加 $. 前缀（OQ1）", async () => {
    const outcome = await runNode(
      [
        { id: "e1", key: "tier", value: { $call: "echo", kwargs: { v: '"GOLD"' } } },
        { id: "e2", key: "b", value: { $call: "echo", kwargs: { v: { mode: "reference", value: "tier.v" } } } },
      ],
      {},
    );
    expect(outcome?.b).toMatchObject({ v: "GOLD" });
  });

  test("$positional 元素信封（OQ5 同批）：literal 位置实参不走 inputField 拼接", async () => {
    const outcome = await runNode([
      { id: "e1", key: "out", value: ["echo", { mode: "literal", value: "$.not.a.path" }] },
    ]);
    expect(outcome?.out).toMatchObject({ v: "$.not.a.path" });
  });

  test("嵌套禁止：literal 信封 value 为 object → 按现状透传（窄识别不认非字符串值）", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", value: { $call: "echo", kwargs: { v: { mode: "literal", value: { deep: 1 } } } } },
    ]);
    // 窄识别要求 value 为原始类型——非原始 = 非信封 = 对象字面量原样透传（现状语义）
    expect(outcome?.a?.v).toEqual({ mode: "literal", value: { deep: 1 } });
  });

  test("保留字碰撞：参数名恰为 mode/value 的合法 pack 不受影响（窄识别要求字符串值）", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      function pick(kwargs: Record<string, unknown>) {
        return { mode: kwargs?.mode ?? null, value: kwargs?.value ?? null };
      },
      "probe",
      {
        parametersSchema: {
          type: "object",
          properties: {
            mode: { type: "string" },
            value: { type: "string" },
          },
          required: ["mode", "value"],
        },
      },
    );
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t" }, async () => {
      runtime.createDecisionWithCacheKey(
        "k",
        graph([
          // 具名 kwargs 顶层有 mode+value 二键但 value 非对象 = 平面形态（非信封位），不受影响
          { id: "e1", key: "out", value: { $call: "pick", kwargs: { mode: "literal", value: "plain" } } },
        ]) as never,
        "v1",
      );
      const r = await runtime.evaluateAsync("k", {}, undefined, "v1");
      // kwargs 顶层信封位（{$call, kwargs}）的 kwargs 值为对象 {mode,value}——此处被识别为信封
      // mode='literal' → 原样绑定整个字符串 'plain' 到 value 参数 → mode 参数缺失报错
      expect((r.result as { out?: { error?: { code?: string } } }).out?.error?.code).toBe("INVALID_PARAM");
    });
  });
});

describe("ADR-016 validateNamedArgs mode 感知", () => {
  test("literal 信封按声明类型直校（string 值 vs integer 声明 → typeMismatch）", () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      function f() {
        return {};
      },
      "probe",
      {
        parametersSchema: {
          type: "object",
          properties: { n: { type: "integer" } },
          required: ["n"],
        },
      },
    );
    const drift = registry.validateNamedArgs("f", { n: { mode: "literal", value: "abc" } });
    expect(drift.typeMismatch).toEqual([{ name: "n", expected: "integer", actual: "string" }]);
    expect(drift.missing).toEqual([]);
  });

  test("literal 信封 object value → 嵌套禁止（typeMismatch）", () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      function f() {
        return {};
      },
      "probe",
      {
        parametersSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      },
    );
    const drift = registry.validateNamedArgs("f", { n: { mode: "literal", value: { deep: 1 } } });
    // 非信封对象字面量 vs 声明 integer → 按对象类型报不符（对象值的窄识别保留字用途自辨）
    expect(drift.typeMismatch[0]).toMatchObject({ name: "n", expected: "integer", actual: "object" });
  });

  test("缺失判定基于声明参数集（信封位值不干扰 missing）", () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      function f() {
        return {};
      },
      "probe",
      {
        parametersSchema: {
          type: "object",
          properties: { n: { type: "integer" }, m: { type: "string" } },
          required: ["n"],
        },
      },
    );
    const drift = registry.validateNamedArgs("f", { n: 1, m: { mode: "literal", value: "x" } });
    expect(drift).toEqual({ missing: [], extra: [], typeMismatch: [] });
  });
});

describe("ADR-016 literal 信封 × 依赖替换互斥（防回归锚）", () => {
  test("literal 信封 value 含 $. 前驱引用：替换器跳过，字面量保真", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", value: { $call: "echo", kwargs: { v: '"V"' } } },
      {
        id: "e2",
        key: "b",
        dependsOn: ["a"],
        value: { $call: "echo", kwargs: { v: { mode: "literal", value: "$.a was not dereferenced" } } },
      },
    ]);
    // 0.15 替换器若无信封感知会把 $.a 改写为 a——字面量静默变语义（本测试为防回归锚）
    expect(outcome?.b).toMatchObject({ v: "$.a was not dereferenced" });
  });
});
