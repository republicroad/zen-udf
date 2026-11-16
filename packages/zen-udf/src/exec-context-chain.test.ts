import { afterAll, describe, expect, test } from "bun:test";
import { DecisionRuntime, getExecContext, runWithExecContext, UdfRegistry } from "./index.ts";

/**
 * 批次 166 · ExecContext 链式传播 + meta 通道存活验证（最小干净版）。
 *
 * R1 判定：双 UDF 链（中间节点 passThrough 未设）两跳的 getExecContext 都
 * 可达且带租户/meta——衰减存在则第二跳丢失。
 */

const seen: { tag: string; tenant?: string; metaOk: boolean; metaModel?: string }[] = [];

function chain_probe() {
  const ctx = getExecContext();
  const entry = {
    tag: "probe",
    tenant: ctx?.tenantId ?? null,
    metaOk: Boolean(ctx?.meta),
    metaModel: (ctx?.meta as { modelId?: string } | undefined)?.modelId ?? null,
  };
  seen.push(entry);
  return entry;
}

const chainGraph = () => ({
  id: "g-chain-ortho",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "第一跳（截断点）",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out1", value: "chain_probe" }] } },
    },
    {
      id: "c2",
      type: "customNode",
      name: "第二跳",
      content: { kind: "UDF", config: { expressions: [{ id: "e2", key: "out2", value: "chain_probe" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "c2", type: "edge" },
    { id: "ed3", sourceId: "c2", targetId: "out", type: "edge" },
  ],
});

describe("批次 166 · ExecContext 链式传播 + meta 存活", () => {
  test("双 UDF 链：两跳 getExecContext 都可达且带租户/meta", async () => {
    seen.length = 0;
    const registry = new UdfRegistry();
    registry.registerFunction(chain_probe, "chain_probe");
    const runtime = new DecisionRuntime({ registry });
    const key = "chain-ortho:1";
    await runWithExecContext({ tenantId: "t-166", requestId: "req-166", meta: { modelId: "m-9" } }, async () => {
      runtime.createDecisionWithCacheKey(key, chainGraph(), "v1");
      await runtime.evaluateAsync(key, { x: 1 }, undefined, "v1");
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({ tag: "probe", tenant: "t-166", metaOk: true, metaModel: "m-9" });
    expect(seen[1]).toEqual({ tag: "probe", tenant: "t-166", metaOk: true, metaModel: "m-9" });
  });
});
