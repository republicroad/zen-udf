import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

/** 可控注册表：mk（回声）、order（记录调用序）、boom（必炸） */
const makeRuntime = () => {
  const registry = new UdfRegistry();
  const order: string[] = [];
  registry.registerFunction(
    function mk(kwargs: Record<string, unknown>) {
      return { v: kwargs?.v ?? null };
    },
    "probe",
    {
      parametersSchema: {
        type: "object",
        properties: { v: { type: ["string", "number", "object"] } },
      },
    },
  );
  registry.registerFunction(
    function note(kwargs: Record<string, unknown>) {
      order.push(String(kwargs?.tag ?? "?"));
      return { tag: kwargs?.tag ?? null };
    },
    "probe",
    {
      parametersSchema: {
        type: "object",
        properties: { tag: { type: "string" } },
      },
    },
  );
  registry.registerFunction(function boom() {
    throw new Error("boom");
  }, "probe");
  return { runtime: new DecisionRuntime({ registry }), registry, order };
};

const node = (expressions: unknown[], passThrough = false) => ({
  id: "c1",
  type: "customNode",
  name: "custom",
  content: { kind: "UDF", config: { expressions, ...(passThrough ? { passThrough } : {}) } },
});

const runNode = async (expressions: unknown[], input: unknown = {}) => {
  const { runtime } = makeRuntime();
  const graph = {
    id: "g",
    nodes: [
      { id: "in", type: "inputNode", name: "Request" },
      node(expressions),
      { id: "out", type: "outputNode", name: "Response" },
    ],
    edges: [
      { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
      { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
    ],
  };
  let outcome: unknown;
  await runWithExecContext({ tenantId: "t" }, async () => {
    runtime.createDecisionWithCacheKey("k", graph, "v1");
    const r = await runtime.evaluateAsync("k", input, undefined, "v1");
    outcome = r.result;
  });
  return outcome as Record<string, unknown>;
};

describe("ADR-015 增补：实例依赖调度（行内顺序求值进函数节点）", () => {
  test("串行链：$.key 自动提取建边，后行实例引用前行输出（并行现状从 INVALID_PARAM 变可解析）", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", value: { $call: "mk", kwargs: { v: "1" } } },
      { id: "e2", key: "b", value: { $call: "mk", kwargs: { v: "$.a.v" } } },
    ]);
    // 联合类型参数派生 'any' 透传：表达式 '1' 求值为 number 1 且不折值
    expect(outcome).toMatchObject({ a: { v: 1 }, b: { v: 1 } });
  });

  test("混合形态：{A,B} 并行 → C 依赖 A → D 依赖 B,C（dependsOn 逃生门 + 自动提取并集）", async () => {
    const order: string[] = [];
    const { runtime } = makeRuntime();
    const expressions = [
      { id: "e1", key: "a", value: { $call: "note", kwargs: { tag: "A" } } },
      { id: "e2", key: "b", value: { $call: "note", kwargs: { tag: "B" } } },
      { id: "e3", key: "c", dependsOn: ["a"], value: { $call: "note", kwargs: { tag: "C" } } },
      { id: "e4", key: "d", dependsOn: ["b", "c"], value: { $call: "note", kwargs: { tag: "D" } } },
    ];
    const graph = {
      id: "g",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        node(expressions),
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
        { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
      ],
    };
    await runWithExecContext({ tenantId: "t" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph, "v1");
      await runtime.evaluateAsync("k", {}, undefined, "v1");
    });
    void order;
    // 拓扑约束断言：C 晚于 A、D 晚于 B 与 C（层内相对顺序不锁死）
    const { buildInstanceSchedule } = DecisionRuntime as unknown as {
      buildInstanceSchedule: (items: unknown[]) => { layers: Array<Array<{ key: string }>> };
    };
    const layers = buildInstanceSchedule(expressions).layers.map((l) => l.map((i) => i.key));
    expect(layers).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  test("依赖环：执行前 CYCLE_DETECTED（报错非死锁，环上键入列）", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", dependsOn: ["b"], value: { $call: "mk", kwargs: {} } },
      { id: "e2", key: "b", dependsOn: ["a"], value: { $call: "mk", kwargs: {} } },
    ]);
    expect(outcome).toMatchObject({
      error: { code: "CYCLE_DETECTED" },
    });
    expect(JSON.stringify((outcome as { error: { issues: string[] } }).error.issues)).toContain("a");
  });

  test("自引用环：单实例 dependsOn 自己 → CYCLE_DETECTED", async () => {
    const outcome = await runNode([{ id: "e1", key: "a", dependsOn: ["a"], value: { $call: "mk", kwargs: {} } }]);
    expect(outcome).toMatchObject({ error: { code: "CYCLE_DETECTED" } });
  });

  test("输出键重声明：DUPLICATE_OUTPUT（并行覆盖与变量遮蔽双风险）", async () => {
    const outcome = await runNode([
      { id: "e1", key: "same", value: { $call: "mk", kwargs: {} } },
      { id: "e2", key: "same", value: { $call: "mk", kwargs: {} } },
    ]);
    expect(outcome).toMatchObject({ error: { code: "DUPLICATE_OUTPUT" } });
  });

  test("悬空引用：引用不存在键不建边、不报环；求值 null 后走 R1 required 语义", async () => {
    const outcome = await runNode([{ id: "e1", key: "b", value: { $call: "mk", kwargs: { v: "$.ghost.v" } } }]);
    // $.ghost 求值 null（与 0.14 前一致）→ 必填参数缺值按 R1 报 INVALID_PARAM
    expect(outcome).toMatchObject({
      b: { error: { code: "INVALID_PARAM", issues: ["v is required"] } },
    });
  });

  test("输出遮蔽输入：$.a 引用建边后取前驱输出（同名输入键被 passThrough 覆盖=既有语义）", async () => {
    const outcome = await runNode(
      [
        // kwargs 字符串值 = zen 表达式：字面量需带引号（"OUTPUT"）
        { id: "e1", key: "a", value: { $call: "mk", kwargs: { v: '"OUTPUT"' } } },
        { id: "e2", key: "b", value: { $call: "mk", kwargs: { v: "$.a" } } },
      ],
      { a: "INPUT" },
    );
    // b 经 $.a 引用（自动建边 + 执行前替换为裸键）取实例 a 的输出；
    // results.a = 'INPUT' 是 passThrough 对同名键的既有覆盖语义（先实例后输入写入）
    expect(outcome).toMatchObject({ b: { v: { v: "OUTPUT" } } });
  });

  test("失败传播：前驱执行错误 → 依赖实例 INVALID_DEPENDENCY，级联不执行", async () => {
    const outcome = await runNode([
      { id: "e1", key: "a", value: { $call: "boom", kwargs: {} } },
      { id: "e2", key: "b", dependsOn: ["a"], value: { $call: "mk", kwargs: { v: 1 } } },
      { id: "e3", key: "c", dependsOn: ["b"], value: { $call: "mk", kwargs: { v: 2 } } },
    ]);
    const b = outcome?.b as { error?: { code?: string; issues?: string[] } };
    const c = outcome?.c as { error?: { code?: string; issues?: string[] } };
    expect(b?.error?.code).toBe("INVALID_DEPENDENCY");
    expect(c?.error?.code).toBe("INVALID_DEPENDENCY");
    expect(JSON.stringify(b?.error?.issues)).toContain("a");
  });

  test("零边快路径：无引用无 dependsOn 的集合维持并行直通（回归）", async () => {
    const outcome = await runNode([
      { id: "e1", key: "x", value: { $call: "mk", kwargs: { v: 1 } } },
      { id: "e2", key: "y", value: { $call: "mk", kwargs: { v: 2 } } },
    ]);
    expect(outcome).toMatchObject({ x: { v: 1 }, y: { v: 2 } });
  });
});

describe("1.0 toMcpTool 派生视图（MCP annotations 单一事实源）", () => {
  test("query → readOnlyHint；act → !readOnly + idempotentHint 直映", async () => {
    const { tool } = await import("./tool.ts");
    const { toMcpTool } = await import("./tool.ts");
    const { Type } = await import("@sinclair/typebox");
    const q = tool({
      namespace: "x",
      name: "q",
      description: "d",
      input: Type.Object({}),
      semantics: "query",
      run: () => ({}),
    });
    const act = tool({
      namespace: "x",
      name: "a",
      description: "d",
      title: "Act!",
      input: Type.Object({}),
      semantics: "act",
      idempotent: true,
      run: () => ({}),
    });
    expect(toMcpTool(q).annotations).toEqual({ readOnlyHint: true });
    expect(toMcpTool(act).annotations).toEqual({ readOnlyHint: false, idempotentHint: true });
    expect(toMcpTool(act).name).toBe("x.a");
    expect(toMcpTool(act).title).toBe("Act!");
  });
});

describe("$.fieldx 作用域立法测试（宿主指定的两处规则图语义）", () => {
  test("表达式节点：$.fieldx 引用本节点前行输出 fieldx", async () => {
    const { ZenEngine } = await import("@republicroad/zen-engine");
    const graph = {
      id: "g-dollar",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "e",
          type: "expressionNode",
          name: "expr",
          content: {
            type: "expression",
            expressions: [
              { id: "x1", key: "fieldx", value: '"FIELDX"' },
              { id: "x2", key: "ref", value: "$.fieldx" },
            ],
          },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "e1", sourceId: "in", targetId: "e", type: "edge" },
        { id: "e2", sourceId: "e", targetId: "out", type: "edge" },
      ],
    };
    const engine = new ZenEngine({ customHandler: async () => ({ output: {} }) });
    const d = engine.createDecision(graph as never);
    const r = await d.evaluate({});
    // $.fieldx = 本节点前行输出 fieldx（"FIELDX"）
    expect((r.result as Record<string, unknown>)?.ref).toBe("FIELDX");
  });
  // 决策表侧（列 field 下/根输入两态 × 条件/输出两单元格面）已另立立法测试：
  // dt-dollar-scope.test.ts（DecisionRuntime 全图）。第一轮 dt 探针返回 {} 的
  // 根源=规则键误用 field 名（须用列 id），已定位并清账——见 dollar-scope-decision.md §2.1。
});
