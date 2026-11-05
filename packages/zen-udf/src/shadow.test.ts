import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
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
});
