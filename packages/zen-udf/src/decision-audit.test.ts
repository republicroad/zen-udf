import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { type DecisionAuditEvent, DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

/** 三语义混合图：query / observe / act 各一个表达式 */
const mixedGraph = (id: string) => ({
  id,
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
            { id: "e1", key: "v", value: "query_udf;;x" },
            { id: "e2", key: "obs", value: "observe_udf;;x" },
            { id: "e3", key: "act", value: "act_udf;;x" },
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
});

interface Spies {
  observeCalls: number;
  actCalls: number;
  queryCalls: number;
}
const makeRegistry = (): { registry: UdfRegistry; spies: Spies } => {
  const spies: Spies = { observeCalls: 0, actCalls: 0, queryCalls: 0 };
  const registry = new UdfRegistry();
  registry.registerFunction(function query_udf(kwargs: Record<string, unknown>) {
    spies.queryCalls += 1;
    return { plus: Number(kwargs?.x ?? 0) + 1 };
  }, "probe");
  registry.registerFunction(
    function observe_udf(kwargs: Record<string, unknown>) {
      spies.observeCalls += 1;
      return { count: spies.observeCalls, x: (kwargs?._node_input_ as { x?: number })?.x ?? null };
    },
    "probe",
    { semantics: "observe" },
  );
  registry.registerFunction(
    function act_udf(kwargs: Record<string, unknown>) {
      spies.actCalls += 1;
      return { blacklisted: true, x: (kwargs?._node_input_ as { x?: number })?.x ?? null };
    },
    "probe",
    { semantics: "act" },
  );
  return { registry, spies };
};

const TENANT = "audit-tenant";

const evaluateOnce = async (input: unknown): Promise<{ audit: DecisionAuditEvent; result: unknown; spies: Spies }> => {
  const events: DecisionAuditEvent[] = [];
  const { registry, spies } = makeRegistry();
  const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
  await runWithExecContext({ tenantId: TENANT, decisionId: "dec-1" }, () => {
    runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
    return Promise.resolve();
  });
  const result = await runWithExecContext({ tenantId: TENANT, userId: "u-1", decisionId: "dec-1" }, () =>
    runtime.evaluateAsync("k", input, undefined, "v1"),
  );
  return { audit: events[events.length - 1], result: result.result, spies };
};

describe("Y2 决策审计事件", () => {
  test("事件形状完整：decisionId/tenant/key@rev/inputHash/output/observed", async () => {
    const input = { x: 7 };
    const { audit } = await evaluateOnce(input);
    expect(audit.decisionId).toBe("dec-1");
    expect(audit.tenantId).toBe(TENANT);
    expect(audit.key).toBe("k");
    expect(audit.rev).toBe("v1");
    expect(audit.inputHash).toBe(createHash("sha256").update(JSON.stringify(input)).digest("hex"));
    expect(audit.source).toBe("live");
    expect(audit.output).toBeDefined();

    const bySemantics = Object.fromEntries(audit.observed.map((o) => [o.name, o.semantics]));
    expect(bySemantics["query_udf"]).toBe("query");
    expect(bySemantics["observe_udf"]).toBe("observe");
    expect(bySemantics["act_udf"]).toBe("act");
    // observed 携带 outcome 快照（回放 journal 来源，D11：output 全量）
    const obs = audit.observed.find((o) => o.name === "observe_udf");
    expect(obs?.outcome).toEqual({ count: 1, x: 7 });
  });

  test("未配置 onDecision 时无审计且 trace 不强制", async () => {
    const { registry, spies } = makeRegistry();
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g2"));
      return Promise.resolve();
    });
    const result = await runWithExecContext({ tenantId: TENANT }, () => runtime.evaluateAsync("k", { x: 1 }));
    expect(result.trace).toBeUndefined();
    expect(spies.observeCalls).toBeGreaterThan(0);
  });

  test("Y2 免 trace 化：配置审计且不传 trace 选项——observed 仍完整、引擎 trace 不强制开启", async () => {
    const events: DecisionAuditEvent[] = [];
    const { registry, spies } = makeRegistry();
    const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k3", mixedGraph("g3"), "v1");
      return Promise.resolve();
    });
    // 关键断言：options 不带任何 trace/debug 诉求（生产高频调用形态）
    const result = await runWithExecContext({ tenantId: TENANT, decisionId: "dec-1" }, () =>
      runtime.evaluateAsync("k3", { x: 9 }, undefined, "v1"),
    );
    // 引擎 trace 未被强制开启——上游 traceData 成本不再随审计产生
    expect(result.trace).toBeUndefined();
    // 审计 observed 经分发器自记账仍完整（三语义 + outcome 快照）
    expect(events).toHaveLength(1);
    const bySemantics = Object.fromEntries(events[0]!.observed.map((o) => [o.name, o.semantics]));
    expect(bySemantics["query_udf"]).toBe("query");
    expect(bySemantics["observe_udf"]).toBe("observe");
    expect(bySemantics["act_udf"]).toBe("act");
    // observed 携带 outcome 快照（该函数未声明参数 schema，位置绑定不落 kwargs 为既有语义）
    expect(events[0]!.observed.find((o) => o.name === "observe_udf")?.outcome).toEqual({ count: 1, x: 9 });
    expect(spies.actCalls).toBe(1);
  });

  test("sink 抛错不中断决策", async () => {
    const { registry } = makeRegistry();
    const runtime = new DecisionRuntime({
      registry,
      onDecision: () => {
        throw new Error("sink down");
      },
    });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g3"));
      return Promise.resolve();
    });
    const result = await runWithExecContext({ tenantId: TENANT }, () => runtime.evaluateAsync("k", { x: 2 }));
    expect(result.result).toBeDefined();
  });
});

describe("Y3 replay 模式（确定性回放）", () => {
  test("observe/act 不重执行（journal 读回），query 以 asOf 重算，结论一致", async () => {
    const events: DecisionAuditEvent[] = [];
    const { registry, spies } = makeRegistry();
    const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-9", eventTime: "2026-09-13T00:00:00Z" }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
      return Promise.resolve();
    });
    const input = { x: 7 };
    await runWithExecContext({ tenantId: TENANT, userId: "u-1", decisionId: "dec-9" }, () =>
      runtime.evaluateAsync("k", input, undefined, "v1"),
    );
    const original = events[events.length - 1];
    const before = { ...spies };

    // 回放：新 runtime 实例（热层状态清零）+ 原审计 journal
    const replayRuntime = new DecisionRuntime({ registry: makeRegistry().registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      replayRuntime.createDecisionWithCacheKey("k", mixedGraph("g-replay"), "v1");
      return Promise.resolve();
    });
    const replayed = await runtime.evaluateReplay(original, input);

    expect(before.observeCalls).toBe(1);
    expect(spies.observeCalls).toBe(1); // 回放未重执行 observe
    expect(spies.actCalls).toBe(1);
    expect(replayed.result).toEqual(original.output);
  });

  test("journal 缺失 → REPLAY_JOURNAL_MISS fail closed", async () => {
    const { registry } = makeRegistry();
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
      return Promise.resolve();
    });

    await runWithExecContext(
      {
        tenantId: TENANT,
        replay: {
          decisionId: "dec-x",
          asOf: "2026-09-13T00:00:00Z",
          journal: [], // 空 journal：observe/act 无从读回
        },
      },
      async () => {
        const result = await runtime.evaluateAsync("k", { x: 1 }, undefined, "v1");
        const act = (result.result as { act?: { error?: { code?: string } } }).act;
        expect(act?.error?.code).toBe("REPLAY_JOURNAL_MISS");
      },
    );
  });

  test("evaluateReplay：输入哈希不匹配时抛错（trust 语义）", async () => {
    const audit: DecisionAuditEvent = {
      decisionId: "d-1",
      tenantId: TENANT,
      key: "k",
      rev: "v1",
      inputHash: "deadbeef",
      journalVersion: 1,
      output: {},
      processingTime: "2026-09-13T00:00:00Z",
      source: "live",
      observed: [],
    };
    await expect(runtime_evaluateReplay(audit, { x: 1 })).rejects.toThrow("replay input hash mismatch");
  });

  async function runtime_evaluateReplay(audit: DecisionAuditEvent, input: unknown) {
    const { registry } = makeRegistry();
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey(audit.key, mixedGraph("g"), audit.rev);
      return Promise.resolve();
    });
    return runtime.evaluateReplay(audit, input);
  }
});

describe("1.0 审计哈希链与 journalVersion", () => {
  test("observed 逐条 hash 链可重算验证（种子=inputHash），journalDigest=链终值", async () => {
    const { createHash } = await import("node:crypto");
    const events: DecisionAuditEvent[] = [];
    const { registry } = makeRegistry();
    const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-chain" }, () => {
      runtime.createDecisionWithCacheKey("kc", mixedGraph("gc"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-chain" }, () =>
      runtime.evaluateAsync("kc", { x: 5 }, undefined, "v1"),
    );
    const audit = events[events.length - 1]!;
    expect(audit.journalVersion).toBe(1);
    expect(audit.journalDigest).toBeTruthy();
    // 链重算：h0=inputHash，hI=sha256(h(I-1)+稳定序列化)
    let chain = audit.inputHash;
    for (const o of audit.observed) {
      const expectHash = createHash("sha256")
        .update(
          chain +
            JSON.stringify({ key: o.key, name: o.name, semantics: o.semantics, outcome: o.outcome, micros: o.micros }),
        )
        .digest("hex");
      expect(o.hash).toBe(expectHash);
      chain = expectHash;
    }
    expect(chain).toBe(audit.journalDigest);
  });

  test("act 语义快照 MUST NOT 携带入参载荷（结构面：observed 无入参字段）", async () => {
    const events: DecisionAuditEvent[] = [];
    const { registry } = makeRegistry();
    const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-ni" }, () => {
      runtime.createDecisionWithCacheKey("kn", mixedGraph("gn"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-ni" }, () =>
      runtime.evaluateAsync("kn", { x: 3, secretPayload: "SENSITIVE" }, undefined, "v1"),
    );
    const audit = events[events.length - 1]!;
    for (const o of audit.observed) {
      const keys = Object.keys(o);
      // 快照面 = key/name/semantics/idempotent/outcome/micros/hash/packVersion——无任何入参字段（packVersion=1.5.0 回放钉扎元数据）
      expect(
        keys.every((k) =>
          ["key", "name", "semantics", "idempotent", "outcome", "micros", "hash", "packVersion"].includes(k),
        ),
      ).toBe(true);
      expect(JSON.stringify(o)).not.toContain("secretPayload");
    }
  });
});

describe("回放钉扎（1.5.0）", () => {
  test("observed 记 packVersion（setPackMeta 版本源）", async () => {
    const events: DecisionAuditEvent[] = [];
    const { registry } = makeRegistry();
    registry.setPackMeta("probe", { origin: "reference", version: "1.2.3" });
    const runtime = new DecisionRuntime({ registry, onDecision: (e) => events.push(e) });
    await runWithExecContext({ tenantId: TENANT, decisionId: "dec-pin" }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: TENANT, userId: "u-1", decisionId: "dec-pin" }, () =>
      runtime.evaluateAsync("k", { x: 7 }, undefined, "v1"),
    );
    const audit = events[events.length - 1];
    expect(audit.observed.length).toBeGreaterThan(0);
    for (const o of audit.observed) expect(o.packVersion).toBe("1.2.3");
  });

  test("pack 未声明版本 → observed.packVersion undefined（不参与钉扎）", async () => {
    const { audit } = await evaluateOnce({ x: 7 });
    for (const o of audit.observed) expect(o.packVersion).toBeUndefined();
  });

  test("journal packVersion ≠ 当前注册表版本 → REPLAY_PIN_MISMATCH fail visible", async () => {
    const { registry } = makeRegistry();
    registry.setPackMeta("probe", { origin: "reference", version: "2.0.0" });
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext(
      {
        tenantId: TENANT,
        replay: {
          decisionId: "dec-pin",
          asOf: "2026-09-13T00:00:00Z",
          journal: [{ key: "act", name: "act_udf", outcome: { blacklisted: true }, packVersion: "1.0.0" }],
        },
      },
      async () => {
        const result = await runtime.evaluateAsync("k", { x: 1 }, undefined, "v1");
        const act = (result.result as { act?: { error?: { code?: string } } }).act;
        expect(act?.error?.code).toBe("REPLAY_PIN_MISMATCH");
      },
    );
  });

  test("journal packVersion 与当前一致 → 正常读回（REPLAYED 语义不变）", async () => {
    const { registry } = makeRegistry();
    registry.setPackMeta("probe", { origin: "reference", version: "2.0.0" });
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: TENANT }, () => {
      runtime.createDecisionWithCacheKey("k", mixedGraph("g"), "v1");
      return Promise.resolve();
    });
    await runWithExecContext(
      {
        tenantId: TENANT,
        replay: {
          decisionId: "dec-pin",
          asOf: "2026-09-13T00:00:00Z",
          journal: [
            { key: "act", name: "act_udf", outcome: { blacklisted: true, x: 1 }, packVersion: "2.0.0" },
            { key: "obs", name: "observe_udf", outcome: { count: 1, x: 1 }, packVersion: "2.0.0" },
          ],
        },
      },
      async () => {
        const result = await runtime.evaluateAsync("k", { x: 1 }, undefined, "v1");
        const body = result.result as { act?: { blacklisted?: boolean }; obs?: { count?: number } };
        expect(body.act).toMatchObject({ blacklisted: true });
        expect(body.obs).toMatchObject({ count: 1 });
      },
    );
  });
});
