import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { InMemoryConcurrencyLimiter } from "./limiter.ts";
import { UdfRegistry } from "./register.ts";

/**
 * 批次 167 · 分区提取器端口立法钉：引擎机制（缓存/熔断/并发闸/审计与指标事件）
 * 的隔离键唯一来源 = 宿主 partitionKey(ctx)；引擎自身零应用域概念、不读 meta。
 */

/** 参考分区提取器：meta.tenantId 约定键 */
const META_TENANT_PARTITION = (ctx: { meta?: Record<string, unknown> }): string | undefined =>
  typeof ctx.meta?.tenantId === "string" ? ctx.meta.tenantId : undefined;

const graph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "probe",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "v", value: "probe_udf;;x" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const makeRegistry = (): UdfRegistry => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function probe_udf(kwargs: Record<string, unknown>) {
      return { plus: Number(kwargs?.x ?? 0) + 1 };
    },
    "probe",
  );
  return registry;
};

describe("批次 167 · 分区提取器端口", () => {
  test("分区隔离：同 key@rev 不同分区互不可见（缓存键含分区段）", async () => {
    const registry = makeRegistry();
    const runtime = new DecisionRuntime({ registry, partitionKey: META_TENANT_PARTITION });
    await runWithExecContext({ meta: { tenantId: "t-a" } }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-a"), "v1");
      return Promise.resolve();
    });

    // t-a 可见；t-b 不可见（key 相同、分区不同）
    const a = await runWithExecContext({ meta: { tenantId: "t-a" } }, () => runtime.evaluateAsync("k", { x: 1 }, undefined, "v1"));
    expect(a.result).toBeDefined();
    await expect(
      runWithExecContext({ meta: { tenantId: "t-b" } }, () => runtime.evaluateAsync("k", { x: 2 }, undefined, "v1")),
    ).rejects.toThrow();
  });

  test("并发闸按分区隔离：同分区串行化 peak=1", async () => {
    let active = 0;
    let peak = 0;
    const registry = new UdfRegistry();
    registry.registerFunction(
      async function probe_udf() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { ok: true };
      },
      "probe",
    );
    const runtime = new DecisionRuntime({
      registry,
      partitionKey: META_TENANT_PARTITION,
      limiter: new InMemoryConcurrencyLimiter(1),
    });
    await runWithExecContext({ meta: { tenantId: "t-a" } }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-lim"), "v1");
      return Promise.resolve();
    });

    // 同分区串行：peak = 1
    await Promise.all([
      runWithExecContext({ meta: { tenantId: "t-a" } }, () => runtime.evaluateAsync("k", { x: 1 }, undefined, "v1")),
      runWithExecContext({ meta: { tenantId: "t-a" } }, () => runtime.evaluateAsync("k", { x: 2 }, undefined, "v1")),
    ]);
    expect(peak).toBe(1);
  });

  test("无分区形态：缓存键退化全局共享（宿主保证 key 唯一或自带分区段）", async () => {
    const runtime = new DecisionRuntime({ registry: makeRegistry() });
    await runWithExecContext({ meta: { userId: "u-1" } }, () => {
      runtime.createDecisionWithCacheKey("bare", graph("g-bare"), "v1");
      return Promise.resolve();
    });
    // 分区缺失形态照常执行（键 `:bare@v1`）
    const r = await runWithExecContext({ meta: { userId: "u-1" } }, () => runtime.evaluateAsync("bare", { x: 5 }, undefined, "v1"));
    expect(r.result).toBeDefined();
  });
});
