import { describe, expect, test } from "vitest";

import { DecisionCache } from "./decision-cache.ts";
import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";

const makeEntry = (v: number) => ({ decision: v as unknown as never, content: v });

describe("DecisionCache（U4 L1 缓存机制）", () => {
  test("LRU：get 刷新位次，超容量驱逐最旧", () => {
    const cache = new DecisionCache({ capacity: 2 });
    cache.set("a", makeEntry(1));
    cache.set("b", makeEntry(2));
    cache.get("a"); // a 变最新
    cache.set("c", makeEntry(3)); // 驱逐 b

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.snapshot().evictions).toBe(1);
  });

  test("同键 set 即原子替换（copy-on-write 热更新）", () => {
    const cache = new DecisionCache();
    cache.set("k", makeEntry(1));
    cache.set("k", makeEntry(2));
    expect(cache.get("k")?.content).toBe(2);
    expect(cache.snapshot().evictions).toBe(0);
  });

  test("指标：hits/misses 计数与快照", () => {
    const cache = new DecisionCache();
    cache.set("k", makeEntry(1));
    cache.get("k");
    cache.get("missing");
    const snap = cache.snapshot();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(1);
    expect(snap.size).toBe(1);
  });

  test("metricsSink 在读写后回调", () => {
    const snapshots: number[] = [];
    const cache = new DecisionCache({ metricsSink: (s) => snapshots.push(s.size) });
    cache.set("k", makeEntry(1));
    cache.get("k");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  test("build 计时埋点累计 builds/buildMicros", () => {
    const cache = new DecisionCache();
    const t = cache.markBuildStart();
    cache.markBuildEnd(t);
    const snap = cache.snapshot();
    expect(snap.builds).toBe(1);
    expect(snap.buildMicros).toBeGreaterThanOrEqual(0);
  });
});

describe("BB3 空闲 TTL", () => {
  test("空闲超 TTL 惰性过期（计 ttlEvictions）", () => {
    let now = 1_000_000;
    const cache = new DecisionCache({ capacity: 10, idleTtlMs: 50, now: () => now });
    cache.set("k", makeEntry(1));
    now += 61; // 超过 50ms 空闲期
    expect(cache.get("k")).toBeUndefined();
    expect(cache.snapshot().ttlEvictions).toBe(1);
  });

  test("get 刷新 lastAccess：持续访问不过期", () => {
    let now = 2_000_000;
    const cache = new DecisionCache({ capacity: 10, idleTtlMs: 50, now: () => now });
    cache.set("k", makeEntry(1));
    now += 30;
    expect(cache.get("k")?.content).toBe(1); // 命中并刷新 lastAccess → now=+30
    now += 30; // 距上次访问 30 < 50 → 仍命中
    expect(cache.get("k")?.content).toBe(1);
    now += 55; // 距上次访问 55 > 50 → 过期
    expect(cache.get("k")).toBeUndefined();
    expect(cache.snapshot().ttlEvictions).toBe(1);
  });
});

describe("DecisionRuntime L1 缓存接入（U4）", () => {
  const graph = {
    id: "g",
    nodes: [
      { id: "in", type: "inputNode", name: "Request" },
      { id: "out", type: "outputNode", name: "Response" },
    ],
    edges: [],
  };

  test("缓存键按租户隔离：同 key 不同租户互不可见", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "t-1" }, async () => {
      runtime.createDecisionWithCacheKey("model", structuredClone(graph));
    });

    // t-2 命中不了 t-1 的条目
    await expect(runWithExecContext({ tenantId: "t-2" }, () => runtime.evaluateAsync("model", {}))).rejects.toThrow(
      /not found, please use createDecisionWithCacheKey/,
    );

    // t-1 正常命中
    const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("model", {}));
    expect(result.result).toBeDefined();
  });

  test("同租户同 key 不同 rev 并存", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("model", structuredClone(graph), "v1");
      runtime.createDecisionWithCacheKey("model", structuredClone(graph), "v2");
      return Promise.resolve();
    });

    await runWithExecContext({ tenantId: "t-1" }, async () => {
      expect(runtime.getDecisionCache("model", "v1")).toBeDefined();
      expect(runtime.getDecisionCache("model", "v2")).toBeDefined();
      expect(runtime.getContentCache("model")).toBeUndefined(); // 缺省 rev=latest → 未创建
      expect(runtime.getContentCache("model", "v1")).toBeDefined();
    });
  });

  test("update/delete 按 rev 定位，latest 互不干扰", async () => {
    const runtime = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("m", structuredClone(graph), "v1");
      runtime.updateDecisionWithCacheKey("m", structuredClone(graph), "v1");
      runtime.deleteDecisionWithCacheKey("m", "v1");
      return Promise.resolve();
    });

    await runWithExecContext({ tenantId: "t-1" }, () => {
      expect(runtime.getDecisionCache("m", "v1")).toBeUndefined();
      return Promise.resolve();
    });
  });

  test("缺省构造回落 globalUdfRegistry（2.0 参考域已拆，缺省为空表）", () => {
    const runtime = new DecisionRuntime();
    expect(runtime.udfFunctionSchemaTools().length).toBe(0); // 同上：参考域在 zen-udf-contrib
  });
});
