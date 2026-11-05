import { describe, expect, test } from "vitest";

import { InMemoryCircuitBreaker } from "./breaker.ts";
import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

const graph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: "target_udf;;x" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const makeRuntime = (): { registry: UdfRegistry; runtime: DecisionRuntime } => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function target_udf(kwargs: Record<string, unknown>) {
      return { value: kwargs?.x ?? null };
    },
    "fixture",
    {
      description: "target udf",
      parametersSchema: { properties: { x: { type: "integer", title: "X" } }, type: "object" },
    },
  );
  return { registry, runtime: new DecisionRuntime({ registry }) };
};

describe("AA3 输入序列化守卫", () => {
  test("NaN 输入 fail fast（不进入引擎，避免 serde 崩溃）", async () => {
    const { runtime } = makeRuntime();
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    await expect(runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: NaN }))).rejects.toThrow(
      "non-finite number",
    );

    await expect(
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: Infinity })),
    ).rejects.toThrow("non-finite number");
  });
});

describe("AA4 批量评估", () => {
  test("evaluateMany：同模型多输入并发，单条失败隔离", async () => {
    const { runtime } = (() => {
      const registry = new UdfRegistry();
      registry.registerFunction(
        function target_udf(kwargs: Record<string, unknown>) {
          return { value: kwargs?.x ?? null };
        },
        "fixture",
        {
          description: "target udf",
          parametersSchema: { properties: { x: { type: "integer", title: "X" } }, type: "object" },
        },
      );
      return { runtime: new DecisionRuntime({ registry }) };
    })();

    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"), "v1");
      return Promise.resolve();
    });

    const results = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateMany("k", [
        { input: { x: 1 }, rev: "v1" },
        { input: { x: 2 }, rev: "v1" },
        { input: { x: NaN }, rev: "v1" }, // 非有限数值 → AA3 守卫隔离
      ]),
    );
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[2].ok).toBe(false);
    if (!results[2].ok) expect((results[2] as { error: string }).error).toContain("non-finite number");
  });

  test("熔断器打开时 CIRCUIT_OPEN 快速失败", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function target_udf() {
      throw new Error("boom");
    }, "fixture");
    const runtime = new DecisionRuntime({
      registry,
      breaker: new InMemoryCircuitBreaker(1, 10_000),
    });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    const first = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 1 }));
    expect((first.result as { out?: { error?: string } }).out?.error).toContain("boom");

    // 熔断打开后快速失败（不再执行 UDF）
    const second = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 2 }));
    expect((second.result as { out?: { error?: { code?: string } } }).out?.error?.code).toBe("CIRCUIT_OPEN");
  });
});
