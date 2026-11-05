import { Type } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";

import { type DecisionAuditEvent, DecisionRuntime } from "@republicroad/zen-udf";
import { runWithExecContext } from "@republicroad/zen-udf";
import { InMemoryRateStore, UdfRegistry } from "@republicroad/zen-udf";
import { setPorts } from "@republicroad/zen-udf";
import { tool, type UdfTool } from "@republicroad/zen-udf";

const makeTool = (overrides: Partial<UdfTool> = {}): UdfTool => ({
  namespace: "probe",
  name: "probe_fn",
  description: "probe",
  semantics: "query",
  temporal: "event",
  stateful: false,
  fidelity: "exact-per-event",
  inputSchema: { type: "object", properties: {} },
  run: async () => ({ ok: true }),
  ...overrides,
});

describe("ADR-021 §1.1 三字段契约（缺省与 pack 缺省 + tool 覆盖）", () => {
  test("缺省解析：tool() 透传 undefined，注册面 schema 解析 ADR 缺省", () => {
    // 缺省不在 tool() 冻结——pack 级缺省（OQ1）对 tool() 声明的工具可达；
    // 消费方一律读 udfFunctionSchema（目录/trace 同源）
    const registry = new UdfRegistry();
    const t = tool({
      namespace: "probe",
      name: "p",
      description: "p",
      input: Type.Object({}),
      run: async () => ({}),
    });
    expect([t.temporal, t.stateful, t.fidelity]).toEqual([undefined, undefined, undefined]);
    registry.register({ id: "probe", tools: [t] });
    const schema = registry.udfFunctionSchema("p");
    expect([schema?.temporal, schema?.stateful, schema?.fidelity]).toEqual(["event", false, "exact-per-event"]);
  });

  test("register：pack 级缺省生效，tool 级显式覆盖（OQ1 裁定）", () => {
    const registry = new UdfRegistry();
    registry.register({
      id: "velocity-like",
      meta: { origin: "extension", version: "1.0.0", temporal: "processing", stateful: true, fidelity: "bucketed" },
      tools: [
        {
          ...makeTool({ name: "inherits_pack", namespace: "velocity-like" }),
          temporal: undefined,
          stateful: undefined,
          fidelity: undefined,
        },
        makeTool({ name: "tool_override", namespace: "velocity-like", fidelity: "interpolated" }),
      ],
    });
    const inherited = registry.udfFunctionSchema("inherits_pack");
    const overridden = registry.udfFunctionSchema("tool_override");
    expect([inherited?.temporal, inherited?.stateful, inherited?.fidelity]).toEqual(["processing", true, "bucketed"]);
    // makeTool 显式声明 temporal:'event' → tool 覆盖 pack 缺省（继承序正确性）
    expect([overridden?.temporal, overridden?.fidelity]).toEqual(["event", "interpolated"]);
  });

  test("ToolContext 传播三字段（宿主重试包装器纪律面）", async () => {
    let seen: Record<string, unknown> = {};
    const registry = new UdfRegistry();
    const runtime = new DecisionRuntime({ registry });
    registry.register({
      id: "probe",
      tools: [
        makeTool({
          name: "ctx_probe",
          namespace: "probe",
          stateful: true,
          fidelity: "bucketed",
          run: async (_i, ctx) => {
            seen = { temporal: ctx?.temporal, stateful: ctx?.stateful, fidelity: ctx?.fidelity };
            return { ok: true };
          },
        }),
      ],
    });
    await runWithExecContext({ tenantId: "t" }, () => {
      runtime.createDecisionWithCacheKey("k", probeGraph("ctx_probe"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: "t" }, () => runtime.evaluateAsync("k", {}, undefined, "v1"));
    expect(seen).toEqual({ temporal: "event", stateful: true, fidelity: "bucketed" });
  });
});

const probeGraph = (fnName: string) => ({
  id: "g",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: `${fnName};;x` }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "e1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "e2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

describe("ADR-021 §1.2 replay 强制（processing + asOf → 宿主 ReplayPolicy）", () => {
  const setup = async (policy: "strict" | "degraded" | undefined, onDecision?: (e: DecisionAuditEvent) => void) => {
    const registry = new UdfRegistry();
    const runtime = new DecisionRuntime({ registry, onDecision });
    registry.register({
      id: "probe",
      tools: [makeTool({ name: "proc_fn", namespace: "probe", temporal: "processing", run: async () => ({ now: 1 }) })],
    });
    // 组合根注入策略：setPorts 经 createUdfRuntime；engine 读 getPorts()
    setPorts(policy ? { replayPolicy: policy } : {});
    await runWithExecContext({ tenantId: "t" }, () => {
      runtime.createDecisionWithCacheKey("k", probeGraph("proc_fn"), "v1");
      return Promise.resolve();
    });
    return runtime;
  };

  test("strict：RATE_NO_EVENT_TIME fail visible", async () => {
    const runtime = await setup("strict");
    const result = await runWithExecContext(
      { tenantId: "t", replay: { decisionId: "d", asOf: "2026-10-13T00:00:00Z", journal: [] } },
      () => runtime.evaluateAsync("k", {}, undefined, "v1"),
    );
    const out = (result.result as { out?: { error?: { code?: string } } }).out;
    expect(out?.error?.code).toBe("RATE_NO_EVENT_TIME");
    setPorts({});
  });

  test("degraded（缺省）：照常执行 + TEMPORAL_FALLBACK 观测标记", async () => {
    const events: DecisionAuditEvent[] = [];
    const runtime = await setup(undefined, (e) => events.push(e));
    const result = await runWithExecContext(
      { tenantId: "t", replay: { decisionId: "d", asOf: "2026-10-13T00:00:00Z", journal: [] } },
      () => runtime.evaluateAsync("k", {}, undefined, "v1"),
    );
    expect((result.result as { out?: { now?: number } }).out).toMatchObject({ now: 1 });
    // observed 通道（audit sink 强制 trace 装配）验 TEMPORAL_FALLBACK 标记
    // （observed 不携带 trace 级 code——marker 以 outcome.temporalFallback 形态在链）
    const observed = events[events.length - 1]?.observed ?? [];
    expect(observed.length).toBe(2); // marker + 真实执行轨迹
    expect(
      observed.some((o) => (o as { outcome?: { temporalFallback?: boolean } }).outcome?.temporalFallback === true),
    ).toBe(true);
    setPorts({});
  });

  test("event 档在 replay 正常重执行（无强制分支）", async () => {
    const registry = new UdfRegistry();
    const runtime = new DecisionRuntime({ registry });
    registry.register({ id: "probe", tools: [makeTool({ name: "event_fn", namespace: "probe" })] });
    await runWithExecContext({ tenantId: "t" }, () => {
      runtime.createDecisionWithCacheKey("k", probeGraph("event_fn"), "v1");
      return Promise.resolve();
    });
    const result = await runWithExecContext(
      { tenantId: "t", replay: { decisionId: "d", asOf: "2026-10-13T00:00:00Z", journal: [] } },
      () => runtime.evaluateAsync("k", {}, undefined, "v1"),
    );
    expect((result.result as { out?: unknown }).out).toMatchObject({ ok: true });
  });
});

describe("ADR-021 §1.5 双名注册（trailing 改名 + 旧名 alias 同函数）", () => {
  test("新名注册在链 + 旧名 alias 带 deprecated 元数据 + 语义同源（同 store 计数贯通）", async () => {
    await import("./reference.ts");
    const { globalUdfRegistry, setRateStore } = await import("@republicroad/zen-udf");
    const store = new InMemoryRateStore();
    setRateStore(store);

    const newSchema = globalUdfRegistry.udfFunctionSchema("trailing_count_1h");
    const oldSchema = globalUdfRegistry.udfFunctionSchema("rate_1h");
    expect(newSchema?.temporal).toBe("event");
    expect(newSchema?.stateful).toBe(true);
    expect(newSchema?.fidelity).toBe("exact-per-event");
    expect(oldSchema?.deprecated?.since).toBe("1.7.0");
    expect(oldSchema?.deprecated?.note).toContain("trailing_count_1h");

    // 语义同源：旧名与别名打同一 store——两次调用 counter 贯通（含重试双计语义）
    await runWithExecContext({ tenantId: "t" }, async () => {
      const rNew = await globalUdfRegistry.call(
        "trailing_count_1h",
        { entity: "ip-x" },
        { name: "trailing_count_1h", signal: new AbortController().signal, deadlineAt: null },
      );
      const rOld = await globalUdfRegistry.call(
        "rate_1h",
        { entity: "ip-x" },
        { name: "rate_1h", signal: new AbortController().signal, deadlineAt: null },
      );
    });
    const after = await store.rate("ip-x", 3_600_000);
    const { getRateStore } = await import("@republicroad/zen-udf");
    const fnStore = getRateStore() as unknown as { instanceId: string; __diagCount: (e?: string) => number };
    expect(after.counter).toBe(3); // 两次注册名调用 + 本次读数调用
  });
});
