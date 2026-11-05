import { describe, expect, test } from "vitest";

import { InMemoryCircuitBreaker } from "./breaker.ts";
import { DecisionRuntime, type MetricsEvent } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { InMemoryConcurrencyLimiter } from "./limiter.ts";
import { UdfRegistry } from "./register.ts";

const graph = (id: string, expr = "probe_udf;;x") => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: expr }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

/** 构造 runtime + 其 metrics 事件数组（sink 闭包绑定该数组） */
const makeRuntime = (
  registry: UdfRegistry,
  extra: { limiter?: InMemoryConcurrencyLimiter; breaker?: InMemoryCircuitBreaker } = {},
): { runtime: DecisionRuntime; events: MetricsEvent[] } => {
  const events: MetricsEvent[] = [];
  const runtime = new DecisionRuntime({
    registry,
    metrics: (event) => events.push(event),
    ...extra,
  });
  return { runtime, events };
};

describe("BB5 统一观测接口", () => {
  test("udf 事件：name/tenantId/micros 齐全", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function probe_udf(kwargs: Record<string, unknown>) {
      return { plus: Number(kwargs?.x ?? 0) + 1 };
    }, "probe");
    const { runtime, events } = makeRuntime(registry);
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 1 }, undefined, "v1"));

    const udfEvents = events.filter((e) => e.kind === "udf");
    expect(udfEvents.length).toBeGreaterThan(0);
    const last = udfEvents[udfEvents.length - 1];
    expect(last).toMatchObject({ kind: "udf", name: "probe_udf", tenantId: "t-1" });
    expect((last as { micros: number }).micros).toBeGreaterThanOrEqual(0);
  });

  test("熔断拒绝产生 circuit 事件（allowed: false）", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function boom_udf() {
      throw new Error("boom");
    }, "probe");
    const breaker = new InMemoryCircuitBreaker(1, 10_000);
    const { runtime, events } = makeRuntime(registry, { breaker });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-cb", "boom_udf;;x"));
      return Promise.resolve();
    });

    await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 1 })); // 触发熔断
    await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 2 })); // 快速失败

    console.log("CEV=" + JSON.stringify(events));
    const circuitEvents = events.filter((e) => e.kind === "circuit");
    expect(circuitEvents.length).toBeGreaterThanOrEqual(1);
    expect(circuitEvents.some((e) => e.allowed === false)).toBe(true);
  });

  test("并发闸等待产生 limiter 事件", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function probe_udf(kwargs: Record<string, unknown>) {
      return { plus: Number(kwargs?.x ?? 0) + 1 };
    }, "probe");
    const limiter = new InMemoryConcurrencyLimiter(1);
    const { runtime, events } = makeRuntime(registry, { limiter });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-lim"), "v1");
      return Promise.resolve();
    });

    await Promise.all([
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 1 }, undefined, "v1")),
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 2 }, undefined, "v1")),
    ]);
    const limiterEvents = events.filter((e) => e.kind === "limiter");
    expect(limiterEvents.length).toBeGreaterThanOrEqual(1);
  });
});
