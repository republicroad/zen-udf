import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { type ContribToolDef, packChecks, type ToolContext, UdfRegistry } from "./register.ts";

const graph = (id: string, expr: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: expr }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

describe("ToolContext（fn 第二参数）", () => {
  test("timeout 到点 abort signal 且 fn 观察到租户身份与截止时间", async () => {
    const observed: Array<Partial<ToolContext> | undefined> = [];
    const registry = new UdfRegistry();
    registry.registerFunction(
      async function slow_get(kwargs: Record<string, unknown>, call?: ToolContext) {
        observed.push(call);
        await new Promise<void>((resolve) => {
          if (call?.signal.aborted) return resolve();
          call?.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { aborted: call?.signal.aborted ?? false };
      },
      "cache",
      { parametersSchema: { properties: { timeout: { type: "integer", default: null } }, type: "object" } },
    );
    const runtime = new DecisionRuntime({ registry });
    const before = Date.now();
    await runWithExecContext({ tenantId: "demo" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph("g1", "slow_get;;80"));
      const result = (await runtime.evaluateAsync("k", {})) as { result?: { out?: { error?: { code?: string } } } };
      // 运行时返回结构化 UDF_TIMEOUT……
      expect(result.result?.out?.error?.code).toBe("UDF_TIMEOUT");
    });
    // ……且 fn 收到了 call 上下文：signal 已 abort、租户/截止时间在位
    expect(observed).toHaveLength(1);
    expect(observed[0]?.signal?.aborted).toBe(true);
    expect(observed[0]?.tenantId).toBe("demo");
    expect(typeof observed[0]?.deadlineAt).toBe("number");
    expect(observed[0]?.deadlineAt as number).toBeGreaterThanOrEqual(before + 80);
  });

  test("无 timeout 约定时 signal 不 abort、deadlineAt 为 null", async () => {
    const observed: Array<Partial<ToolContext> | undefined> = [];
    const registry = new UdfRegistry();
    registry.registerFunction(
      async function fast_get(kwargs: Record<string, unknown>, call?: ToolContext) {
        observed.push(call);
        return "ok";
      },
      "cache",
      { parametersSchema: { properties: { timeout: { type: "integer", default: null } }, type: "object" } },
    );
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "demo" }, async () => {
      runtime.createDecisionWithCacheKey("k", graph("g2", "fast_get;;"));
      const result = (await runtime.evaluateAsync("k", {})) as { result?: { out?: unknown } };
      expect(result.result?.out).toBe("ok");
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.signal?.aborted).toBe(false);
    expect(observed[0]?.deadlineAt).toBeNull();
  });
});

describe("defineToolFor 泛型 kwargs", () => {
  test("fn 的 kwargs 获得声明的参数类型（编译期），运行时行为不变", async () => {
    const tool: ContribToolDef = {
      name: "get",
      description: "demo",
      parametersSchema: {
        properties: { key: { type: "string", title: "Key" } },
        required: ["key"],
        title: "get",
        type: "object",
      },
      returnsSchema: { type: "string", title: "value" },
      fn: (kwargs: Record<string, unknown>) => `v:${(kwargs as { key: string }).key}`,
    };
    const registry = new UdfRegistry();
    registry.registerFunction(tool.fn, "demo", { parametersSchema: { properties: {}, type: "object" } }, tool.name);
    const result = await registry.call("get", { key: "k1" });
    expect(result).toBe("v:k1");
  });
});

describe("packChecks 质量层", () => {
  const baseTool: ContribToolDef = {
    name: "get",
    description: "demo get",
    parametersSchema: {
      properties: { key: { type: "string", title: "Key" } },
      required: ["key"],
      title: "get",
      type: "object",
    },
    returnsSchema: { type: "string", title: "value" },
    fn: async () => "ok",
  };

  test("合格包零 issue", () => {
    expect(packChecks({ namespace: "cache", tools: [{ ...baseTool }] })).toEqual([]);
  });

  test("缺 description / returnsSchema / required 越界 / timeout 形状 / act 幂等", () => {
    const issues = packChecks({
      namespace: "cache",
      tools: [
        { ...baseTool, description: "  ", returnsSchema: undefined },
        {
          ...baseTool,
          name: "push",
          description: "demo push",
          semantics: "act" as const,
          parametersSchema: {
            properties: { key: { type: "string", title: "Key" }, timeout: { type: "string", title: "Timeout" } },
            required: ["missing_key"],
            title: "push",
            type: "object",
          },
        },
      ],
    });
    const checks = issues.map((i) => `${i.tool}:${i.check}`);
    expect(checks).toContain("get:description-required");
    expect(checks).toContain("get:returns-schema-required");
    expect(checks).toContain("push:required-mismatch");
    expect(checks).toContain("push:timeout-shape");
    expect(checks).toContain("push:act-idempotent");
    for (const issue of issues) {
      expect(["error", "warning"]).toContain(issue.severity);
    }
  });

  test("namespace 命名偏离约定给 warning 不给 error", () => {
    const issues = packChecks({ namespace: "MyCache", tools: [{ ...baseTool }] });
    expect(issues.map((i) => i.check)).toEqual(["namespace-convention"]);
    expect(issues[0].severity).toBe("warning");
  });
});

describe("数组调用模式（默认；;; 为旧图兼容）", () => {
  test("expressions.value 为数组 [fn, ...args] 时与 ;; 字符串等价", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      async function echo_add(kwargs: Record<string, unknown>) {
        return { sum: (kwargs.a as number) + (kwargs.b as number) };
      },
      "math",
      { parametersSchema: { properties: { a: { type: "integer" }, b: { type: "integer" } }, type: "object" } },
    );
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "demo" }, async () => {
      // 数组形态（默认）
      runtime.createDecisionWithCacheKey("ka", {
        id: "ga",
        nodes: [
          { id: "in", type: "inputNode", name: "Request" },
          {
            id: "c1",
            type: "customNode",
            name: "custom",
            content: {
              kind: "UDF",
              config: { expressions: [{ id: "e1", key: "out", value: ["echo_add", "1", "2"] }] },
            },
          },
          { id: "out", type: "outputNode", name: "Response" },
        ],
        edges: [
          { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
          { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
        ],
      } as never);
      const ra = (await runtime.evaluateAsync("ka", {})) as { result?: { out?: { sum?: number } } };
      expect(ra.result?.out?.sum).toBe(3);
      // ;; 字符串形态（旧图兼容）——同参等价
      runtime.createDecisionWithCacheKey("ks", {
        id: "gs",
        nodes: [
          { id: "in", type: "inputNode", name: "Request" },
          {
            id: "c1",
            type: "customNode",
            name: "custom",
            content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: "echo_add;;1;;2" }] } },
          },
          { id: "out", type: "outputNode", name: "Response" },
        ],
        edges: [
          { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
          { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
        ],
      } as never);
      const rs = (await runtime.evaluateAsync("ks", {})) as { result?: { out?: { sum?: number } } };
      expect(rs.result?.out?.sum).toBe(3);
    });
  });
});

describe("命名调用形态（$call 保留键 + 具名实参）", () => {
  const setup = () => {
    const registry = new UdfRegistry();
    registry.registerFunction(
      function pair(kwargs: Record<string, unknown>) {
        return { a: kwargs.a, b: kwargs.b };
      },
      "probe",
      {
        parametersSchema: {
          properties: { a: { type: "integer" }, b: { type: "integer", default: 5 } },
          type: "object",
        },
      },
    );
    const runtime = new DecisionRuntime({ registry });
    return { registry, runtime };
  };

  const namedGraph = (value: Record<string, unknown>) => ({
    id: "gn",
    nodes: [
      { id: "in", type: "inputNode", name: "Request" },
      {
        id: "c1",
        type: "customNode",
        name: "custom",
        content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value }] } },
      },
      { id: "out", type: "outputNode", name: "Response" },
    ],
    edges: [
      { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
      { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
    ],
  });

  test("具名实参（表达式串与字面量混用）+ 可选参数缺省回退", async () => {
    const { runtime } = setup();
    await runWithExecContext({ tenantId: "demo" }, async () => {
      runtime.createDecisionWithCacheKey("k", namedGraph({ $call: "pair", a: "1" }) as never);
      const r = (await runtime.evaluateAsync("k", {})) as { result?: { out?: { a?: unknown; b?: unknown } } };
      expect(r.result?.out?.a).toBe(1);
      expect(r.result?.out?.b).toBe(5); // 缺省回退 schema default
    });
  });

  test("字段名笔误 → INVALID_PARAM unknown argument", async () => {
    const { runtime } = setup();
    await runWithExecContext({ tenantId: "demo" }, async () => {
      runtime.createDecisionWithCacheKey("k", namedGraph({ $call: "pair", aa: "1" }) as never);
      const r = (await runtime.evaluateAsync("k", {})) as {
        result?: { out?: { error?: { code?: string; issues?: string[] } } };
      };
      expect(r.result?.out?.error?.code).toBe("INVALID_PARAM");
      expect(r.result?.out?.error?.issues?.[0]).toContain("unknown argument");
    });
  });

  test("缺 $call → INVALID_PARAM 结构化报错", async () => {
    const { runtime } = setup();
    await runWithExecContext({ tenantId: "demo" }, async () => {
      runtime.createDecisionWithCacheKey("k", namedGraph({ a: "1" }) as never);
      const r = (await runtime.evaluateAsync("k", {})) as { result?: { out?: { error?: { code?: string } } } };
      expect(r.result?.out?.error?.code).toBe("INVALID_PARAM");
    });
  });
});
