import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";

/**
 * dt 单元格双命名空间（宿主立法 2026-10-04）：带 `$` = 当前列 field 命名空间；
 * 不带 `$`（裸键）= 入参命名空间。条件侧与输出侧同规。
 * 两轮实证记录见 docs/dollar-scope-decision.md §2.1——第一轮误判根源：
 * 规则键须用列 id（c1/c2）而非 field 名（zen-engine 序列化契约）。
 */
const dtGraph = (colField: string | null, cell: string, out: string) => ({
  id: "g",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "dt",
      type: "decisionTableNode",
      name: "DT",
      content: {
        hitPolicy: "first",
        inputs: colField ? [{ id: "c1", field: colField, name: "xxx" }] : [],
        outputs: [{ id: "c2", field: "out", name: "Out" }],
        rules: [{ _id: "r1", ...(colField ? { c1: cell } : {}), c2: out }],
      },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "e1", sourceId: "in", targetId: "dt", type: "edge" },
    { id: "e2", sourceId: "dt", targetId: "out", type: "edge" },
  ],
});

const evaluate = async (key: string, graph: unknown, input: unknown) => {
  const runtime = new DecisionRuntime({ registry: new (await import("./register.ts")).UdfRegistry() });
  return runWithExecContext({ tenantId: "t" }, async () => {
    runtime.createDecisionWithCacheKey(key, graph as never, "v1");
    return runtime.evaluateAsync(key, input, undefined, "v1");
  });
};

describe("dt 单元格双命名空间（$=列 field 命名空间；裸键=入参命名空间；条件侧与输出侧同规）", () => {
  test("列已设 field：条件 $.fieldx 经列命名空间解析为 cart.fieldx（根同名值不干扰）", async () => {
    const r = await evaluate("k1", dtGraph("cart", '$.fieldx == "X"', '"HIT"'), {
      cart: { fieldx: "X" },
      fieldx: "NOTX",
    });
    expect(r.result).toMatchObject({ out: "HIT" });
  });

  test("列已设 field：输出 $.fieldx 同吃列命名空间 → cart.fieldx", async () => {
    const r = await evaluate("k2", dtGraph("cart", '$.fieldx == "X"', "$.fieldx"), {
      cart: { fieldx: "X" },
      fieldx: "ROOTKEY",
    });
    expect(r.result).toMatchObject({ out: "X" });
  });

  test("列已设 field：条件裸键恒=入参命名空间（根同名值命中）", async () => {
    const r = await evaluate("k3", dtGraph("cart", 'fieldx == "ROOTKEY"', '"HIT"'), {
      cart: { fieldx: "X" },
      fieldx: "ROOTKEY",
    });
    expect(r.result).toMatchObject({ out: "HIT" });
  });

  test("列已设 field：输出裸键恒=入参命名空间 → 根 fieldx", async () => {
    const r = await evaluate("k4", dtGraph("cart", '$.fieldx == "X"', "fieldx"), {
      cart: { fieldx: "X" },
      fieldx: "ROOTKEY",
    });
    expect(r.result).toMatchObject({ out: "ROOTKEY" });
  });

  test("列未设：$.fieldx 无绑定 → 输出单元格失败缺省（缺 out 键，非报错非误值）", async () => {
    const r = await evaluate("k5", dtGraph(null, "true", "$.fieldx"), { fieldx: "ROOT" });
    expect(r.result).toEqual({});
  });

  test("列未设：输出裸键 = 输入根（推荐写法）", async () => {
    const r = await evaluate("k6", dtGraph(null, "true", "fieldx"), { fieldx: "ROOT" });
    expect(r.result).toMatchObject({ out: "ROOT" });
  });

  test("列未设：条件裸键 = 输入根（推荐写法）", async () => {
    const r = await evaluate("k7", dtGraph(null, 'fieldx == "ROOT"', '"HIT"'), { fieldx: "ROOT" });
    expect(r.result).toMatchObject({ out: "HIT" });
  });
});
