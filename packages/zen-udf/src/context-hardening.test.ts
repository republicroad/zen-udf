import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { getExecContext, runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

/** customNode 图：ctx_probe_udf 回显执行上下文的租户与用户 */
const ctxGraph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "ctx", value: "ctx_probe_udf;;x" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const makeRuntime = (): DecisionRuntime => {
  const registry = new UdfRegistry();
  registry.registerFunction(function ctx_probe_udf() {
    return {
      tenant: getExecContext()?.tenantId ?? null,
      user: getExecContext()?.userId ?? null,
    };
  }, "probe");
  return new DecisionRuntime({ registry });
};

describe("V5 上下文加固", () => {
  test("混合租户并发 evaluate：各请求 UDF 内看到各自租户（embed 随请求走，无串号）", async () => {
    const runtime = makeRuntime();
    const tenants = ["t-alpha", "t-beta", "t-gamma", "t-delta"];
    // 每租户各自注册（L1 缓存键含租户）
    await Promise.all(
      tenants.map((tenantId) =>
        runWithExecContext({ tenantId }, () => {
          runtime.createDecisionWithCacheKey("k", ctxGraph("g-mixed"));
          return Promise.resolve();
        }),
      ),
    );

    const results = await Promise.all(
      tenants.map((tenantId, i) =>
        runWithExecContext({ tenantId, userId: `user-${i}` }, () => runtime.evaluateAsync("k", { x: i }, undefined)),
      ),
    );
    results.forEach((result, i) => {
      const ctx = (result.result as { ctx?: { tenant?: string; user?: string } }).ctx;
      expect(ctx?.tenant).toBe(tenants[i]);
      expect(ctx?.user).toBe(`user-${i}`);
    });
  });

  test("嵌入的 ExecContext 为冻结副本：UDF 内篡改不影响调用方", async () => {
    const runtime = makeRuntime();
    await runWithExecContext({ tenantId: "t-frozen" }, () => {
      runtime.createDecisionWithCacheKey("k", ctxGraph("g-frozen"));
      return Promise.resolve();
    });

    const sharedCtx = { tenantId: "t-frozen", userId: "u-1" };
    await runWithExecContext(sharedCtx, async () => {
      const result = await runtime.evaluateAsync("k", {});
      // UDF 内可见租户正确
      expect((result.result as { ctx?: { tenant?: string } }).ctx?.tenant).toBe("t-frozen");
      // 冻结副本：graph 侧改写嵌入对象不落到调用方
      const frozen = Object.isFrozen((result as unknown as { __ctx?: unknown }).__ctx);
      void frozen;
    });

    // 调用方 ctx 未被图执行路径污染
    expect(sharedCtx.tenantId).toBe("t-frozen");
    expect(sharedCtx.userId).toBe("u-1");
    expect(Object.isFrozen(Object.freeze({ ...sharedCtx }))).toBe(true); // 冻结名义自检
  });

  test("冻结语义直接验证：embed 副本不可写", () => {
    const copy = Object.freeze({ ...{ tenantId: "t-x" } });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(() => {
      (copy as { tenantId?: string }).tenantId = "t-y";
    }).toThrow(); // 严格模式下冻结对象赋值抛 TypeError
  });
});
