import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { getExecContext, runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

// 缺省构造回落 globalUdfRegistry：装载参考域

const graph = {
  id: "tenant-graph",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [],
};

/** 带 customNode 的图：expr 调用 probe_udf 并把结果写到 out 字段 */
const customGraph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: {
        kind: "UDF",
        config: { expressions: [{ id: "e1", key: "out", value: "probe_udf;;x" }] },
      },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

describe("DecisionRuntime 租户上下文强制（U2）", () => {
  test("无租户上下文时 evaluate 拒绝执行（fail closed）", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "setup" }, () => {
      runtime.createDecisionWithCacheKey("k", structuredClone(graph));
      return Promise.resolve();
    });

    await expect(runtime.evaluateAsync("k", { x: 1 })).rejects.toThrow("missing exec context tenantId");
    await expect(runWithExecContext({ userId: "u1" }, () => runtime.evaluateAsync("k", { x: 1 }))).rejects.toThrow(
      "missing exec context tenantId",
    );
  });

  test("携带 tenantId 时正常执行", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", structuredClone(graph));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1", userId: "u1" }, () =>
      runtime.evaluateAsync("k", { x: 1 }),
    );
    expect(result.result).toBeDefined();
  });

  test("tenantExempt 豁免单租户部署", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantExempt: true }, () => {
      runtime.createDecisionWithCacheKey("k", structuredClone(graph));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantExempt: true }, () => runtime.evaluateAsync("k", { x: 1 }));
    expect(result.result).toBeDefined();
  });

  test("tenantId 经 AsyncLocalStorage 贯穿并发链路", async () => {
    const probe = async (): Promise<string | undefined> => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      return getExecContext()?.tenantId;
    };
    const results = await Promise.all([
      runWithExecContext({ tenantId: "t-a" }, probe),
      runWithExecContext({ tenantId: "t-b" }, probe),
      runWithExecContext({ tenantId: "t-c" }, probe),
    ]);
    expect(results).toEqual(["t-a", "t-b", "t-c"]);
  });
});

describe("DecisionRuntime 实例注入（U3）", () => {
  const makeRegistry = (tag: string): UdfRegistry => {
    const registry = new UdfRegistry();
    registry.registerFunction(function probe_udf(kwargs: Record<string, unknown>) {
      return { tag, x: kwargs?.x ?? null };
    }, "probe");
    return registry;
  };

  test("两个运行时实例同名 UDF 各自解析，互不串扰", async () => {
    const ra = new DecisionRuntime({ registry: makeRegistry("A") });
    const rb = new DecisionRuntime({ registry: makeRegistry("B") });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      ra.createDecisionWithCacheKey("k", customGraph("ga"));
      rb.createDecisionWithCacheKey("k", customGraph("gb"));
      return Promise.resolve();
    });

    const [a, b] = await Promise.all([
      runWithExecContext({ tenantId: "t-1" }, () => ra.evaluateAsync("k", { x: 1 })),
      runWithExecContext({ tenantId: "t-1" }, () => rb.evaluateAsync("k", { x: 2 })),
    ]);
    expect((a.result as { out: { tag: string } }).out.tag).toBe("A");
    expect((b.result as { out: { tag: string } }).out.tag).toBe("B");
  });

  test("空注册表的运行时对未知 UDF 返回结构化错误而非抛出", async () => {
    const runtime = new DecisionRuntime({ registry: new UdfRegistry() });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", customGraph("g-empty"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 1 }));
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("udf probe_udf not found");
  });

  test("缺省构造回落 globalUdfRegistry（2.0 参考域已拆，缺省为空表）", () => {
    const runtime = new DecisionRuntime();
    expect(runtime.udfFunctionSchemaTools().length).toBe(0); // batteries-included 已拆：参考域在 zen-udf-contrib，组合根显式装载
  });

  test("ExecContext 经输入保留键贯穿 TSFN 边界，UDF 内可读（ALS 重建立）", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function probe_udf() {
      return { tenantInUdf: getExecContext()?.tenantId ?? null, userInUdf: getExecContext()?.userId ?? null };
    }, "probe");
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", customGraph("g-als"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1", userId: "u-9" }, () =>
      runtime.evaluateAsync("k", { x: 1 }),
    );
    const out = (result.result as { out?: { tenantInUdf?: string; userInUdf?: string } }).out;
    expect(out?.tenantInUdf).toBe("t-1");
    expect(out?.userInUdf).toBe("u-9");
  });
});
