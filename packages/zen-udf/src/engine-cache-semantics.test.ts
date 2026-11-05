import { ZenEngine } from "@republicroad/zen-engine";
import { describe, expect, test } from "vitest";

/**
 * zen-engine 2.0.2 缓存语义哨兵（源码核对 + 探针实证，设计见 docs/design/zen-udf-multi-tenant.md）：
 * - 函数 loader 无引擎级缓存：engine.evaluate(key)/getDecision(key) 每次回调 loader 并重新解析
 * - createDecision 返回的 ZenDecision 可复用：解析一次、evaluate N 次
 * - customNode 不影响上述语义；customHandler 每次 evaluate 回调
 * 多租户缓存架构（宿主自管 Map<key, ZenDecision>）建立在这些语义之上；
 * 升级 zen-engine 后本测试若失败，说明缓存行为变化，需重新评估缓存设计。
 */
const graph = {
  id: "g",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [],
};

describe("zen-engine 缓存语义（2.0.2 实证）", () => {
  test("函数 loader：evaluate(key) 每次回调 loader（引擎不缓存）", async () => {
    let loads = 0;
    const engine = new ZenEngine({
      loader: async () => {
        loads += 1;
        return Buffer.from(JSON.stringify(graph));
      },
    });
    await engine.evaluate("k", { a: 1 });
    await engine.evaluate("k", { a: 2 });
    expect(loads).toBe(2);
  });

  test("函数 loader：getDecision(key) 每次回调 loader", async () => {
    let loads = 0;
    const engine = new ZenEngine({
      loader: async () => {
        loads += 1;
        return Buffer.from(JSON.stringify(graph));
      },
    });
    await engine.getDecision("k");
    await engine.getDecision("k");
    expect(loads).toBe(2);
  });

  test("createDecision 实例可复用：解析一次 evaluate 多次", async () => {
    const engine = new ZenEngine({});
    const decision = engine.createDecision(structuredClone(graph));
    const first = await decision.evaluate({ x: 1 });
    const second = await decision.evaluate({ x: 2 });
    expect(first.result).toBeDefined();
    expect(second.result).toBeDefined();
  });

  test("customNode：缓存决策复用不受影响，handler 每次 evaluate 回调", async () => {
    let handlerCalls = 0;
    const engine = new ZenEngine({
      customHandler: async () => {
        handlerCalls += 1;
        return { output: { handled: true } };
      },
    });
    const customGraph = {
      id: "gc",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "c1",
          type: "customNode",
          name: "custom",
          content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "r", value: "some_udf;;x" }] } },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
        { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
      ],
    };
    const decision = engine.createDecision(customGraph);
    await decision.evaluate({ x: 1 });
    await decision.evaluate({ x: 2 });
    expect(handlerCalls).toBe(2);
  });
});
