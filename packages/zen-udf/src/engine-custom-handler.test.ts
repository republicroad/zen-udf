import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

/**
 * L7/ADR-008：宿主 customHandler 与内置 UDF 分发的组合语义。
 *
 * 契约断言用 spy（query_udf 是否被分发）——不依赖位置参数绑定的输入流语义
 * （那是独立的输入绑定问题，见批 3 备注）。
 *
 * 路由键 = node.name（TS 侧 request.node.content 为 null——wasm 引擎不把
 * content 传给 TS handler，宿主只能按 id/name 路由，见 debug-node-shape 实测）。
 *
 * 图形态：PROTO 节点为旁支（in → p1，无下游）——与 verdict 的
 * 「协议特化节点 + 注册表 UDF 工具并存」场景同构。
 */

const graph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "p1",
      type: "customNode",
      name: "proto",
      content: { kind: "UDF", config: { expressions: [{ id: "ep", key: "ignored", value: '"proto"' }] } },
    },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: {
        kind: "UDF",
        config: { expressions: [{ id: "e1", key: "v", value: "query_udf;;x" }] },
      },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "e2", sourceId: "in", targetId: "p1", type: "edge" },
  ],
});

const makeRegistry = () => {
  const registry = new UdfRegistry();
  const spies = { queryCalls: 0 };
  registry.registerFunction(function query_udf(kwargs: Record<string, unknown>) {
    spies.queryCalls += 1;
    return { plus: Number(kwargs?.x ?? 0) + 1 };
  }, "probe");
  return { registry, spies };
};

const PROTO_OUTPUT = { handled: true, protocol: "demo" };

describe("L7 customHandler 组合语义（ADR-008）", () => {
  test("decline 语义：宿主 handler 返回 undefined 时回落内置 UDF 分发（不再遮蔽）", async () => {
    const { registry, spies } = makeRegistry();
    let protoHandlerCalls = 0;
    const runtime = new DecisionRuntime({
      registry,
      customHandler: async (request) => {
        console.log("[HOST decline]", JSON.stringify(request.node?.name));
        const node = request.node as { name?: string };
        if (node?.name === "proto") {
          protoHandlerCalls += 1;
          return { output: PROTO_OUTPUT };
        }
        return undefined; // not-handled → decline
      },
    });

    await runWithExecContext({ tenantId: "l7", decisionId: "d" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph("g"), "v1");
      await runtime.evaluateAsync("k", { x: 7 }, undefined, "v1");
    });

    // L7 契约：宿主 handler 接管了 PROTO（1 次询问），同时注册表 UDF 不被遮蔽
    expect(protoHandlerCalls).toBe(1);
    expect(spies.queryCalls).toBeGreaterThanOrEqual(1);
  });

  test("显式委托：宿主 handler 内调 runtime.handleCustomNode 组合协议与注册表工具", async () => {
    const { registry, spies } = makeRegistry();
    let protoHandlerCalls = 0;
    let delegatedCalls = 0;
    // 构造时即注入最终 handler（wasm 侧在构造时捕获分发函数，事后换挂不生效）；
    // handler 闭包自引用 runtime，显式标注类型以断开初始化循环推导
    const runtime: DecisionRuntime = new DecisionRuntime({
      registry,
      customHandler: async (request) => {
        const node = request.node as { name?: string };
        if (node?.name === "proto") {
          protoHandlerCalls += 1;
          return { output: PROTO_OUTPUT };
        }
        delegatedCalls += 1;
        // 显式委托到内置分发器（L7 选项 1）
        return runtime.handleCustomNode(request);
      },
    });
    await runWithExecContext({ tenantId: "l7", decisionId: "d" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph("g"), "v1");
      await runtime.evaluateAsync("k", { x: 7 }, undefined, "v1");
    });

    expect(protoHandlerCalls).toBe(1);
    expect(delegatedCalls).toBeGreaterThanOrEqual(1);
    expect(spies.queryCalls).toBeGreaterThanOrEqual(1);
  });

  test("无宿主 handler 时全部走内置分发（缺省行为不回归）", async () => {
    const { registry, spies } = makeRegistry();
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "l7", decisionId: "d" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph("g"), "v1");
      await runtime.evaluateAsync("k", { x: 7 }, undefined, "v1");
    });
    expect(spies.queryCalls).toBeGreaterThanOrEqual(1);
  });
});
