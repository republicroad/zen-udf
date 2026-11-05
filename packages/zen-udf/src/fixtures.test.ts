import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { createZenExpressionEvaluator } from "./expression-evaluator.ts";
import { runDecisionTests } from "./fixtures.ts";
import { UdfRegistry } from "./register.ts";
import { createRuntimeExecutor } from "./runtime-executor.ts";

const model = {
  id: "g-fixture",
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
            { id: "e1", key: "score", value: "score_udf;;x" },
            { id: "e2", key: "flag", value: "flag_udf;;x" },
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

/** 宿主模型（键隔离测试用）：与夹具模型同名 key 但内容不同 */
const hostModel = {
  id: "g-host",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [{ id: "ed1", sourceId: "in", targetId: "out", type: "edge" }],
};

const makeRuntime = (): DecisionRuntime => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function score_udf(kwargs: Record<string, unknown>) {
      return { value: kwargs?.x ?? 0 };
    },
    "fixture",
    {
      description: "score udf",
      parametersSchema: { properties: { x: { type: "integer", title: "X" } }, type: "object" },
    },
  );
  registry.registerFunction(
    function flag_udf(kwargs: Record<string, unknown>) {
      return { flagged: kwargs?.flagged === true };
    },
    "fixture",
    { semantics: "observe" },
  );
  return new DecisionRuntime({ registry });
};

describe("Y7 决策测试夹具运行器（ADR-014 executor 反转形态）", () => {
  test("deep/path/predicate 三种断言，报告逐夹具记录", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "score-model", model, rev: "v1" }),
      fixtures: [
        {
          name: "x=3 → score 3",
          input: { x: 3, flagged: false },
          expect: {
            mode: "deep",
            value: { score: { value: 3 }, flag: { flagged: false }, x: 3, flagged: false },
          },
        },
        {
          name: "path 断言",
          input: { x: 5, flagged: false },
          expect: { mode: "path", path: "score.value", value: 5 },
        },
        {
          name: "predicate 断言",
          input: { x: 9, flagged: false },
          expect: { mode: "predicate", test: (r) => (r as { score?: { value?: number } }).score?.value === 9 },
        },
        {
          name: "不匹配的夹具记录失败",
          input: { x: 1, flagged: false },
          expect: { mode: "path", path: "score.value", value: 999 },
        },
      ],
    });

    expect(report.passed).toBe(3);
    expect(report.failed).toBe(1);
    const failed = report.results.find((r) => !r.passed);
    expect(failed?.error).toBe("expectation mismatch");
    expect(failed?.outcome).toBe("assertion-failed");
  });

  test("journal 桩：observe UDF 走回放语义不重执行（效果隔离）", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "jm", model, rev: "v1" }),
      fixtures: [
        {
          name: "observe 走桩",
          input: { x: 4, flagged: true },
          asOf: "2026-09-13T00:00:00Z",
          journal: [{ key: "flag", name: "flag_udf", outcome: { flagged: "FROM_JOURNAL" } }],
          expect: { mode: "path", path: "flag.flagged", value: "FROM_JOURNAL" },
        },
      ],
    });
    expect(report.failed).toBe(0);
  });

  test("smoke 语义：无 expect 的夹具 passed = 执行无异常（NamedExample 接入形态）", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "smoke", model, rev: "v1" }),
      fixtures: [{ name: "只跑不断言", input: { x: 6, flagged: false } }],
    });
    expect(report.passed).toBe(1);
    expect(report.results[0]).toMatchObject({ outcome: "passed", actual: { score: { value: 6 } } });
    expect(report.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("expression 断言：context 平铺裸键（OQ3 ① 定稿）", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "expr", model, rev: "v1" }),
      expressionEvaluator: createZenExpressionEvaluator(),
      fixtures: [
        {
          name: "表达式通过",
          input: { x: 5, flagged: false },
          expect: { mode: "expression", source: "score.value == 5" },
        },
        {
          name: "表达式不通过",
          input: { x: 5, flagged: false },
          expect: { mode: "expression", source: "score.value == 999" },
        },
      ],
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results[1]?.outcome).toBe("assertion-failed");
    expect(report.results[1]?.error).toBe("expectation mismatch");
  });

  test("expression 断言缺求值器 → assertion-failed 且 error 注明", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "expr-none", model, rev: "v1" }),
      fixtures: [
        {
          name: "缺求值器",
          input: { x: 5, flagged: false },
          expect: { mode: "expression", source: "score.value == 5" },
        },
      ],
    });
    expect(report.failed).toBe(1);
    expect(report.results[0]?.error).toContain("expressionEvaluator");
  });

  test("outcome 三分：passed / assertion-failed / execution-error", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "outcomes", model, rev: "v1" }),
      fixtures: [
        { name: "通过", input: { x: 2, flagged: false }, expect: { mode: "path", path: "score.value", value: 2 } },
        { name: "断言失败", input: { x: 2, flagged: false }, expect: { mode: "path", path: "score.value", value: 0 } },
        { name: "执行错误", input: { x: Number.NaN, flagged: false } },
      ],
    });
    const outcomes = report.results.map((r) => r.outcome);
    expect(outcomes).toEqual(["passed", "assertion-failed", "execution-error"]);
    expect(report.results[2]?.error).toContain("non-finite");
  });

  test("traceHits：executor 上报命中节点 id（结果矩阵列）", async () => {
    const runtime = makeRuntime();
    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "hits", model, rev: "v1" }),
      fixtures: [{ name: "命中", input: { x: 2, flagged: false } }],
    });
    expect(report.results[0]?.traceHits).toContain("c1");
  });

  test("__fixtures__ 键隔离：同键宿主模型不被夹具覆盖", async () => {
    const runtime = makeRuntime();
    await runWithExecContext({ tenantId: "fixtures" }, () => {
      runtime.createDecisionWithCacheKey("score-model", hostModel, "v1");
      return Promise.resolve();
    });

    const report = await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "score-model", model, rev: "v1" }),
      fixtures: [{ name: "夹具用自己的模型", input: { x: 3, flagged: false } }],
    });
    expect(report.passed).toBe(1);

    // 宿主键未被覆盖：同键同 rev 求值仍是宿主直通模型（标记透传）；
    // 若被夹具模型覆盖，输出会是 {score, flag, x, flagged} 而非标记
    const hostOutcome = await runWithExecContext({ tenantId: "fixtures" }, () =>
      runtime.evaluateAsync("score-model", { hostMarker: "keep" }, undefined, "v1"),
    );
    expect(hostOutcome.result).toMatchObject({ hostMarker: "keep" });
  });

  test("onProgress 逐夹具回调（携带 index/total）", async () => {
    const runtime = makeRuntime();
    const progress: Array<{ name: string; index: number; total: number }> = [];
    await runDecisionTests({
      executor: createRuntimeExecutor(runtime, { key: "progress", model, rev: "v1" }),
      fixtures: [
        { name: "a", input: { x: 1, flagged: false } },
        { name: "b", input: { x: 2, flagged: false } },
      ],
      onProgress: (r, index, total) => progress.push({ name: r.name, index, total }),
    });
    expect(progress.map((p) => p.name)).toEqual(["a", "b"]);
    expect(progress[0]).toMatchObject({ index: 0, total: 2 });
  });
});

describe("createZenExpressionEvaluator：OQ3 ① 定稿——context 平铺，禁 $ 根导航", () => {
  const evaluator = createZenExpressionEvaluator();

  test("对象结果平铺：顶层键直引（standard 语料已测面）", () => {
    expect(evaluator("score.value == 5", { score: { value: 5 } })).toBe(true);
    expect(evaluator("score.value == 999", { score: { value: 5 } })).toBe(false);
    expect(evaluator("a * 2 == 20", { a: 10 })).toBe(true);
  });

  test("非对象结果绑 result 单键（标量/数组/null 可断言）", () => {
    expect(evaluator("result == 42", 42)).toBe(true);
    expect(evaluator("result == 41", 42)).toBe(false);
    expect(evaluator('result[0] == "a"', ["a", "b"])).toBe(true);
    expect(evaluator("result == null", null)).toBe(true);
  });

  test("哨兵：$ 根与 $.path 导航在独立求值环境恒 null 静默（禁用形态）", () => {
    // 旧约定 $.result.x 的失效实证：条件恒 false → 表达式断言恒不通过（fail-visible，
    // 不再经 { result: data } 包装产生「result 键恰好存在」的假阳性通道）
    expect(evaluator("$.result.score.value == 5", { score: { value: 5 } })).toBe(false);
    expect(evaluator("$.score.value == 5", { score: { value: 5 } })).toBe(false);
  });
});

describe("fixtures 指纹（1.5.0 回放钉扎）", () => {
  test("同夹具集指纹稳定；任一夹具变更即漂移", async () => {
    const run = async (fixtures: Parameters<typeof runDecisionTests>[0]["fixtures"]) =>
      (
        await runDecisionTests({
          executor: createRuntimeExecutor(makeRuntime(), { key: "fp", model, rev: "v1" }),
          fixtures,
        })
      ).fingerprint;
    const base = [{ name: "a", input: { x: 1, flagged: false } }];
    const again = await run(base);
    expect(again).toBe(await run([{ name: "a", input: { x: 1, flagged: false } }]));
    expect(again).not.toBe(await run([{ name: "a", input: { x: 2, flagged: false } }]));
    expect(again).toMatch(/^[0-9a-f]{8}$/);
  });
});
