import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { InMemoryConcurrencyLimiter, NoopConcurrencyLimiter } from "./limiter.ts";
import { UdfRegistry } from "./register.ts";

/** 带 customNode 的图：expr 调用 target_udf，结果写 out 字段 */
const graph = (id: string, expr = "target_udf;;p1;;p2;;p3") => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: {
        kind: "UDF",
        config: { expressions: [{ id: "e1", key: "out", value: expr }] },
      },
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
      parametersSchema: {
        properties: {
          p1: { type: "string", title: "P1" },
          p2: { type: "integer", title: "P2" },
          p3: { type: "string", title: "P3", default: "" },
          timeout: { type: "integer", title: "Timeout", default: 0 },
        },
        // R1/ADR-011：required 数组是唯一权威（旧隐式语义「无 default=必填」已废弃，
        // 对齐 JSON Schema 标准语义——本夹具迁移自隐式形态）
        required: ["p1", "p2"],
      },
    },
    "target_udf",
  );
  return registry;
};

const evalGraph = async (runtime: DecisionRuntime, input: unknown) =>
  runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", input));

describe("执行规范 §6.1 参数校验", () => {
  test("必填位置参数缺失 → INVALID_PARAM 结构化错误", async () => {
    const registry = makeRegistry((kwargs) => ({ echo: kwargs?.p1 ?? null }));
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    // p2 为必填（无默认值），表达式传 null
    const result = await evalGraph(runtime, { p1: "a", p2: null, p3: "c" });
    const out = (result.result as { out?: { error?: { code?: string; issues?: string[] } } }).out;
    expect(out?.error?.code).toBe("INVALID_PARAM");
    expect(JSON.stringify(out?.error?.issues)).toContain("p2 is required");
  });

  test("有默认值的参数缺失不报错（funcBindParams 回退）", async () => {
    const registry = makeRegistry((kwargs) => ({ got: kwargs?.p1 ?? null, timeout: kwargs?.timeout ?? null }));
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    const result = await evalGraph(runtime, { p1: "a", p2: 2, p3: "c" });
    const out = (result.result as { out?: { got?: string } }).out;
    expect(out?.got).toBe("a");
  });
});

describe("执行规范 §6.2 超时约定", () => {
  test("kwargs.timeout 超时返回 UDF_TIMEOUT 结构化错误", async () => {
    const registry = makeRegistry(async (kwargs) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { done: true, input: kwargs?.p1 ?? null };
    });
    // timeout 声明为 schema 最后一个参数（默认 0 = 不限时），表达式第 4 位传入
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-timeout", "target_udf;;p1;;p2;;p3;;timeout"));
      return Promise.resolve();
    });

    const result = await evalGraph(runtime, { p1: "a", p2: 1, p3: "b", timeout: 80 });
    const out = (result.result as { out?: { error?: { code?: string; message?: string } } }).out;
    expect(out?.error?.code).toBe("UDF_TIMEOUT");
  });

  test("未超时则正常返回", async () => {
    const registry = makeRegistry(async (kwargs) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { done: true, input: kwargs?.p1 ?? null };
    });
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-ok", "target_udf;;p1;;p2;;p3;;timeout"));
      return Promise.resolve();
    });

    const result = await evalGraph(runtime, { p1: "ok", p2: 1, p3: "b", timeout: 1000 });
    const out = (result.result as { out?: { done?: boolean; input?: string } }).out;
    expect(out?.done).toBe(true);
    expect(out?.input).toBe("ok");
  });
});

describe("执行规范 §6.3 并发闸", () => {
  test("InMemoryConcurrencyLimiter 串行化同租户调用", async () => {
    let active = 0;
    let peak = 0;
    const registry = new UdfRegistry();
    registry.registerFunction(async function target_udf() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active -= 1;
      return { ok: true };
    }, "target");

    const limiter = new InMemoryConcurrencyLimiter(1);
    const runtime = new DecisionRuntime({ registry, limiter });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    const [a, b] = await Promise.all([
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { p1: "a", p2: 1, p3: "c" })),
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { p1: "b", p2: 2, p3: "c" })),
    ]);
    expect(peak).toBe(1);
    expect((a.result as { out?: { ok?: boolean } }).out?.ok).toBe(true);
    expect((b.result as { out?: { ok?: boolean } }).out?.ok).toBe(true);
  });

  test("NoopConcurrencyLimiter 不限制并发", async () => {
    let active = 0;
    let peak = 0;
    const registry = new UdfRegistry();
    registry.registerFunction(async function target_udf() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active -= 1;
      return { ok: true };
    }, "target");

    const runtime = new DecisionRuntime({ registry, limiter: new NoopConcurrencyLimiter() });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g"));
      return Promise.resolve();
    });

    await Promise.all([
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { p1: "a", p2: 1, p3: "c" })),
      runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { p1: "b", p2: 2, p3: "c" })),
    ]);
    expect(peak).toBe(2);
  });
});
