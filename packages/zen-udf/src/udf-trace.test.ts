import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

/** customNode 图：target_udf 返回值写入 out 字段 */
const graph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: "target_udf" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const makeRegistry = (fn: (kwargs: Record<string, unknown>) => unknown): UdfRegistry => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    fn,
    "target",
    {
      description: "target udf",
      returnsSchema: {
        type: "object",
        title: "TargetResult",
        properties: { ok: { type: "boolean", title: "Ok" } },
        required: ["ok"],
      },
    },
    "target_udf",
  );
  return registry;
};

/** 断言 c1 节点 traceData.udf 存在并返回首条 */
const firstUdfTrace = (result: { trace?: unknown }): Record<string, unknown> | undefined => {
  const trace = result.trace as Record<string, { traceData?: { udf?: Array<Record<string, unknown>> } }> | undefined;
  return trace?.["c1"]?.traceData?.udf?.[0];
};

describe("V2 返回值契约（resultValidation）", () => {
  test("warn（缺省）：违例结果原样下发，traceData 记 INVALID_RESULT", async () => {
    const registry = makeRegistry(() => "not-an-object");
    const runtime = new DecisionRuntime({ registry }); // 缺省 warn
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-warn"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    expect((result.result as { out?: unknown }).out).toBe("not-an-object"); // 行为不变
    const trace = firstUdfTrace(result);
    expect(trace?.code).toBe("INVALID_RESULT");
    expect(JSON.stringify(trace?.issues)).toContain("result type expected object, got string");
  });

  test("enforce：违例结果替换为 INVALID_RESULT 结构化错误", async () => {
    const registry = makeRegistry(() => "not-an-object");
    const runtime = new DecisionRuntime({ registry, resultValidation: "enforce" });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-enforce"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    const out = (result.result as { out?: { error?: { code?: string } } }).out;
    expect(out?.error?.code).toBe("INVALID_RESULT");
    expect(firstUdfTrace(result)?.code).toBe("INVALID_RESULT");
  });

  test("off：不校验不记违例", async () => {
    const registry = makeRegistry(() => "not-an-object");
    const runtime = new DecisionRuntime({ registry, resultValidation: "off" });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-off"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    expect((result.result as { out?: unknown }).out).toBe("not-an-object");
    expect(firstUdfTrace(result)?.code).toBeUndefined();
  });

  test("合规返回值不产生违例记录", async () => {
    const registry = makeRegistry(() => ({ ok: true }));
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-ok"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    expect(firstUdfTrace(result)?.code).toBeUndefined();
  });
});

describe("V3 UDF 级 traceData", () => {
  test("正常调用记录 key/name/micros", async () => {
    const registry = makeRegistry(() => ({ ok: true }));
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-trace"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    const trace = firstUdfTrace(result);
    expect(trace?.key).toBe("out");
    expect(trace?.name).toBe("target_udf");
    expect(trace?.micros).toBeGreaterThanOrEqual(0);
  });

  test("无返回值声明的 UDF 不产生违例（returnsSchema 缺省豁免）", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function target_udf() {
      return 12345;
    }, "target");
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-noschema"));
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}, { trace: true }));
    expect(firstUdfTrace(result)?.code).toBeUndefined();
  });
});
