import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { getExecContext, runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

const graphWith = (id: string, expr: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "v", value: expr }] } },
    },
    {
      id: "c2",
      type: "customNode",
      name: "dispose",
      content: { kind: "UDF", config: { expressions: [{ id: "e2", key: "act", value: "act_udf;;x" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "c2", type: "edge" },
    { id: "ed3", sourceId: "c2", targetId: "out", type: "edge" },
  ],
});

describe("AA1 影子评估", () => {
  test("分歧 rev：字段级 diff + act 影子侧不重执行", async () => {
    const spies = { actCalls: 0 };
    const registry = new UdfRegistry();
    registry.registerFunction(
      function query_udf(kwargs: Record<string, unknown>) {
        return { plus: Number(kwargs?.x ?? 0) + 1 };
      },
      "probe",
      {
        description: "query udf",
        parametersSchema: {
          properties: { x: { type: "integer", title: "X" }, y: { type: "integer", title: "Y" } },
          type: "object",
        },
      },
    );
    registry.registerFunction(
      function act_udf() {
        spies.actCalls += 1;
        return { blacklisted: true };
      },
      "probe",
      { semantics: "act" },
    );
    const runtime = new DecisionRuntime({ registry });

    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graphWith("g1", "query_udf;;x"), "v1");
      runtime.createDecisionWithCacheKey("k", graphWith("g2", "query_udf;;y"), "v2");
      return Promise.resolve();
    });

    const shadow = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateShadow("k", { prod: "v1", shadow: "v2" }, { x: 1, y: 3 }),
    );

    // v1: x=1 → plus=2；v2: y=3 → plus=4 —— 字段级差异
    expect(shadow.equivalent).toBe(false);
    expect(shadow.differences.some((d) => d.path === "v.plus")).toBe(true);
    // act 影子侧不重执行：整轮仅生产侧调用一次
    expect(spies.actCalls).toBe(1);
  });

  test("一致 rev：equivalent 为 true 且无差异", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function query_udf(kwargs: Record<string, unknown>) {
      return { plus: Number(kwargs?.x ?? 0) + 1 };
    }, "probe");
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graphWith("g1", "query_udf;;x"), "v1");
      return Promise.resolve();
    });

    const shadow = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateShadow("k", { prod: "v1", shadow: "v1" }, { x: 2 }),
    );
    expect(shadow.equivalent).toBe(true);
    expect(shadow.differences).toHaveLength(0);
  });

  test("批次 80：observe 影子只读降级——影子侧读共享状态不写入", async () => {
    const store = { count: 0 };
    const registry = new UdfRegistry();
    // 工具自治降级：影子侧读当前计数（getExecContext()?.shadow 分支），生产侧写入
    registry.registerFunction(
      function observe_udf() {
        const shadow = getExecContext()?.shadow;
        if (shadow) return { seen: store.count, shadow: true };
        store.count += 1;
        return { seen: store.count };
      },
      "probe",
      { semantics: "observe", stateful: true },
    );
    const graph = {
      id: "g",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "c1",
          type: "customNode",
          name: "custom",
          content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "v", value: "observe_udf;;" }] } },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
        { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
      ],
    };
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph, "v1");
      return Promise.resolve();
    });

    // 生产侧正常执行：写入一次
    const prod = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateAsync("k", {}, { trace: true }, "v1"),
    );
    expect((prod.result as { v?: { seen?: number } })?.v?.seen).toBe(1);
    expect(store.count).toBe(1);

    // 影子评估：生产侧再写一次（→2），影子侧只读不写（seen=2 读取、count 仍 2）
    const shadow = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateShadow("k", { prod: "v1", shadow: "v1" }, {}),
    );
    expect(store.count).toBe(2); // 整轮只生产侧写了一次
    expect((shadow.prod as { v?: { seen?: number } })?.v?.seen).toBe(2);
    expect((shadow.shadow as { v?: { seen?: number; shadow?: boolean } })?.v?.seen).toBe(2);
    expect((shadow.shadow as { v?: { shadow?: boolean } })?.v?.shadow).toBe(true);
  });

  test("批次 80：请求内 observe memo——同请求同参调用不双记", async () => {
    const store = { count: 0 };
    const registry = new UdfRegistry();
    registry.registerFunction(
      function observe_udf() {
        store.count += 1;
        return { seen: store.count };
      },
      "probe",
      { semantics: "observe", stateful: true },
    );
    // 同一 customNode 两个表达式实例调同参 observe → memo 命中，第二次 DEDUPED
    const graph = {
      id: "g",
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
                { id: "e1", key: "v1", value: "observe_udf;;" },
                { id: "e2", key: "v2", value: "observe_udf;;" },
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
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph, "v1");
      return Promise.resolve();
    });

    const result = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateAsync("k", {}, { trace: true }, "v1"),
    );
    // fact-once：同请求同参 observe 只真实执行一次
    expect(store.count).toBe(1);
    const out = result.result as { v1?: { seen?: number }; v2?: { seen?: number } };
    expect(out?.v1?.seen).toBe(1);
    expect(out?.v2?.seen).toBe(1); // memo 返回首次 outcome
    // trace 标注 DEDUPED
    const trace = result.trace as Record<string, { traceData?: { udf?: Array<{ code?: string }> } }>;
    const codes = Object.values(trace ?? {}).flatMap((n) => (n?.traceData?.udf ?? []).map((t) => t.code));
    expect(codes).toContain("DEDUPED");
  });
});
