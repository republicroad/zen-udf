import { describe, expect, test } from "vitest";

import { DecisionRuntime, type MetricsEvent, type UdfTrace } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { InMemoryCircuitBreaker } from "./breaker.ts";
import { UdfRegistry } from "./register.ts";

// 5.1.0 traceSink 事实流（§5.6 观测面分立）：每 UDF 调用一条保真记录
// （args/outcome/nodeId），与 metrics 聚合信号分立；发射序 = 拓扑序。

const model = {
  id: "g-sink",
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
            { id: "e1", key: "score", value: { $call: "score_udf", kwargs: { x: "x", tag: "'literal'" } } },
            { id: "e2", key: "echo", value: { $call: "echo_udf", kwargs: { v: "$.score.value" } } },
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

const makeRuntime = (extra: Partial<ConstructorParameters<typeof DecisionRuntime>[0]> = {}) => {
  const registry = new UdfRegistry();
  registry.registerFunction(
    function score_udf(kwargs: Record<string, unknown>) {
      return { value: (kwargs?.x as number) ?? 0, tag: kwargs?.tag };
    },
    "calc",
    {
      parametersSchema: {
        type: "object",
        properties: { x: { type: "integer", title: "X" }, tag: { type: "string", title: "Tag" } },
        required: ["x"],
      },
    },
  );
  registry.registerFunction(
    function echo_udf(kwargs: Record<string, unknown>) {
      return { seen: kwargs?.v ?? null };
    },
    "calc",
    { parametersSchema: { type: "object", properties: { v: { type: "integer", title: "V" } } } },
  );
  return new DecisionRuntime({ registry, ...extra });
};

describe("traceSink 事实流（5.1.0 §5.6 与 metrics 分立）", () => {
  test("每调用一条保真记录：key/name/micros/args/outcome/nodeId 齐备；发射序 = 表达式序", async () => {
    const entries: UdfTrace[] = [];
    const rt = makeRuntime({ traceSink: (t) => entries.push({ ...t }) });
    await runWithExecContext({ meta: { tenantId: "t1" } }, async () => {
      rt.createDecisionWithCacheKey("k1", model, "v1");
      await rt.evaluateAsync("k1", { x: 7 }, undefined, "v1");
    });
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    expect(first.key).toBe("score");
    expect(first.name).toBe("score_udf");
    expect(first.nodeId).toBe("c1");
    expect(first.args).toEqual({ x: 7, tag: "literal" }); // kwargs 求值后（'literal' 信封 literal 绑定）
    expect(first.outcome).toEqual({ value: 7, tag: "literal" });
    expect(typeof first.micros).toBe("number");
    expect(second.key).toBe("echo");
    expect(second.args).toEqual({ v: 7 }); // $.score.value 表达式求值结果（路径取到内层字段）
    expect(second.outcome).toEqual({ seen: 7 });
  });

  test("生产 trace 纪律（evaluate 不传 trace 选项）下照发——事实流不受 trace 卡控", async () => {
    const entries: UdfTrace[] = [];
    const rt = makeRuntime({ traceSink: (t) => entries.push({ ...t }) });
    await runWithExecContext({ meta: { tenantId: "t1" } }, async () => {
      rt.createDecisionWithCacheKey("k2", model, "v1");
      const outcome = await rt.evaluateAsync("k2", { x: 1 }, undefined, "v1");
      expect((outcome as { trace?: unknown }).trace).toBeUndefined(); // trace:false 响应无轨迹
    });
    expect(entries).toHaveLength(2); // 材料仍全量落 sink
  });

  test("metrics 面零改动：事件形状保持聚合信号（无 args/outcome/key/nodeId）", async () => {
    const entries: UdfTrace[] = [];
    const events: MetricsEvent[] = [];
    const rt = makeRuntime({ metrics: (e) => events.push(e), traceSink: (t) => entries.push(t) });
    await runWithExecContext({ meta: { tenantId: "t1" } }, async () => {
      rt.createDecisionWithCacheKey("k3", model, "v1");
      await rt.evaluateAsync("k3", { x: 1 }, undefined, "v1");
    });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.kind).toBe("udf");
      expect((e as { args?: unknown }).args).toBeUndefined();
      expect((e as { outcome?: unknown }).outcome).toBeUndefined();
      expect((e as { key?: unknown }).key).toBeUndefined();
      expect((e as { nodeId?: unknown }).nodeId).toBeUndefined();
    }
    expect(entries).toHaveLength(2); // 两面并行各司其职
  });

  test("缺省不设 traceSink = 零行为（不 crash，不产出）", async () => {
    const rt = makeRuntime();
    await runWithExecContext({ meta: { tenantId: "t1" } }, async () => {
      rt.createDecisionWithCacheKey("k4", model, "v1");
      const outcome = await rt.evaluateAsync("k4", { x: 1 }, undefined, "v1");
      expect((outcome as { result?: unknown }).result).toBeDefined();
    });
  });

  test("错误路径保真：INVALID_PARAM 带已求值 args；发射序保持", async () => {
    const entries: UdfTrace[] = [];
    const registry = new UdfRegistry();
    registry.registerFunction(
      function strict_udf(kwargs: Record<string, unknown>) {
        return { ok: 1, got: kwargs?.x };
      },
      "calc",
      {
        parametersSchema: {
          type: "object",
          properties: { x: { type: "integer", title: "X" } },
        },
      },
    );
    const rt = new DecisionRuntime({ registry, traceSink: (t) => entries.push({ ...t }) });
    const badModel = {
      id: "g-bad",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "cb",
          type: "customNode",
          name: "custom",
          content: {
            kind: "UDF",
            config: { expressions: [{ id: "e1", key: "r", value: { $call: "strict_udf", kwargs: { y: "x" } } }] },
          },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "ed1", sourceId: "in", targetId: "cb", type: "edge" },
        { id: "ed2", sourceId: "cb", targetId: "out", type: "edge" },
      ],
    };
    await runWithExecContext({ meta: { tenantId: "t1" } }, async () => {
      rt.createDecisionWithCacheKey("k5", badModel, "v1");
      await rt.evaluateAsync("k5", { x: 3 }, undefined, "v1");
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe("INVALID_PARAM");
    expect(entries[0].args).toEqual({ y: 3 }); // 已求值部分（未知参数 y 如实暴露）
    expect(entries[0].nodeId).toBe("cb");
  });

  test("熔断路径：CIRCUIT_OPEN 条目带最终绑定 args（回放材料完整）", async () => {
    const entries: UdfTrace[] = [];
    const registry = new UdfRegistry();
    registry.registerFunction(
      function flaky_udf() {
        throw new Error("downstream down");
      },
      "calc",
      { parametersSchema: { type: "object", properties: { q: { type: "integer", title: "Q" } } } },
    );
    const rt = new DecisionRuntime({
      registry,
      breaker: new InMemoryCircuitBreaker(1, 60_000),
      traceSink: (t) => entries.push({ ...t }),
    });
    const bModel = {
      id: "g-brk",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "ck",
          type: "customNode",
          name: "custom",
          content: {
            kind: "UDF",
            config: { expressions: [{ id: "e1", key: "r", value: { $call: "flaky_udf", kwargs: { q: "q" } } }] },
          },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "ed1", sourceId: "in", targetId: "ck", type: "edge" },
        { id: "ed2", sourceId: "ck", targetId: "out", type: "edge" },
      ],
    };
    await runWithExecContext({ meta: { tenantId: "tb" } }, async () => {
      rt.createDecisionWithCacheKey("k6", bModel, "v1");
      await rt.evaluateAsync("k6", { q: 9 }, undefined, "v1"); // 首调失败（UDF_ERROR）
      await rt.evaluateAsync("k6", { q: 9 }, undefined, "v1"); // 熔断打开（CIRCUIT_OPEN）
    });
    expect(entries.map((t) => t.code)).toEqual(["UDF_ERROR", "CIRCUIT_OPEN"]);
    expect(entries[1].args).toEqual({ q: 9 });
    expect(entries[1].nodeId).toBe("ck");
  });
});
