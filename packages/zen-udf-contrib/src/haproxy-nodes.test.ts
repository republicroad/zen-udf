// 聚集检测 / 近似滑窗计数 / A:B 计分板工具的单元测试（mock 节点：slot 路由、ratio 守卫、键消塌缩）
import { describe, expect, test } from "vitest";

import { createApproxCountTool } from "./approx-count.ts";
import { createClusterDetectTool } from "./cluster-detect.ts";
import { createScoreboardTool } from "./scoreboard.ts";
import { HaProxyCountNode } from "./haproxy-nodes.ts";

type Call = { path: string; query: string; method: "GET" | "POST" };

/** 录制式 mock 节点：按 path 记录调用，count/distinct/tally 可编程返回 */
function mockNode(handlers: {
  count?: (key: string) => { counter: number; idle: number; ttl: number };
  distinct?: (group: string, value: string) => Record<string, number>;
  scoreboard?: (key: string, slot: string) => Record<string, number>;
}) {
  const calls: Call[] = [];
  const node = {
    approxCount: async (entity: string) => {
      const r = handlers.count?.(entity) ?? { counter: 0, idle: 0, ttl: 0 };
      return r;
    },
    clusterProbe: async (group: string, value: string) => {
      const r = handlers.distinct?.(group, value) ?? { uv: 0, pv: 0, gpv: 0, gidle: 0, vidle: 0, ttl: 0 };
      return r;
    },
    scoreboardTally: async (entity: string, slot: string) => {
      const r = handlers.scoreboard?.(entity, slot) ?? { a: 0, b: 0 };
      return r;
    },
    __calls: calls,
    __asNode: () => node as unknown as HaProxyCountNode,
  };
  return node;
}

describe("scoreboard_tally 槽位路由", () => {
  test("A 真 B 假 → slot=A", async () => {
    const node = mockNode({ scoreboard: () => ({ a: 5, b: 2 }) });
    const tool = createScoreboardTool(node.__asNode(), { ratioFloor: 1 });
    const r = (await tool.run({ entity: "e1", incA: true, incB: false })) as { a: number; b: number; ratio: number };
    expect(r.a).toBe(5);
    expect(r.b).toBe(2);
    expect(r.ratio).toBeCloseTo(2.5);
  });

  test("双真 → slot=AB（后端双槽各 +1 语义由后端承担）", async () => {
    const node = mockNode({ scoreboard: () => ({ a: 1, b: 1 }) });
    const tool = createScoreboardTool(node.__asNode());
    const r = (await tool.run({ entity: "e1", incA: true, incB: true })) as { a: number; b: number };
    expect(r.a).toBe(1);
    expect(r.b).toBe(1);
  });

  test("双假 → slot=NONE（纯读）", async () => {
    const node = mockNode({ scoreboard: () => ({ a: 7, b: 3 }) });
    const tool = createScoreboardTool(node.__asNode());
    const r = (await tool.run({ entity: "e1", incA: false, incB: false })) as { a: number; b: number };
    expect(r.a).toBe(7);
    expect(r.b).toBe(3);
  });

  test("ratio 分母守卫：b < floor → null（velocity_ratio 同款）", async () => {
    const node = mockNode({ scoreboard: () => ({ a: 100, b: 2 }) });
    const tool = createScoreboardTool(node.__asNode(), { ratioFloor: 3 });
    const r = (await tool.run({ entity: "e1", incA: true, incB: false })) as { ratio: number | null };
    expect(r.ratio).toBeNull();
  });

  test("ratio 分母守卫：b ≥ floor → 数值", async () => {
    const node = mockNode({ scoreboard: () => ({ a: 90, b: 30 }) });
    const tool = createScoreboardTool(node.__asNode(), { ratioFloor: 3 });
    const r = (await tool.run({ entity: "e1", incA: true, incB: false })) as { ratio: number | null };
    expect(r.ratio).toBe(3);
  });
});

describe("approx_trailing_count 键消塌缩", () => {
  test("kind 进键（同实体不同 kind 计数独立）", async () => {
    const perKey = new Map<string, number>();
    const node = mockNode({
      count: (key: string) => {
        const n = (perKey.get(key) ?? 0) + 1;
        perKey.set(key, n);
        return { counter: n, idle: 0, ttl: 3600 };
      },
    });
    const tool = createApproxCountTool(node.__asNode());
    const r1 = (await tool.run({ entity: "dev-1", kind: "login" })) as { counter: number };
    const r2 = (await tool.run({ entity: "dev-1", kind: "pay" })) as { counter: number };
    expect([...perKey.keys()].sort()).toEqual(["login:dev-1", "pay:dev-1"]);
    expect(r1.counter).toBe(1);
    expect(r2.counter).toBe(1);
  });
});

describe("cluster_probe 三级节拍透传", () => {
  test("uv/pv/gpv/gidle/vidle/gttl/vttl 全字段透传", async () => {
    const node = mockNode({
      distinct: () => ({ uv: 7, pv: 42, gpv: 50, gidle: 3, vidle: 9, gttl: 600, vttl: 300 }),
    });
    const tool = createClusterDetectTool(node.__asNode());
    const r = (await tool.run({ group: "ip-1", value: "13800138000" })) as Record<string, number>;
    expect(r.uv).toBe(7);
    expect(r.pv).toBe(42);
    expect(r.gpv).toBe(50);
    expect(r.gidle).toBe(3);
    expect(r.vidle).toBe(9);
    expect(r.gttl).toBe(600);
    expect(r.vttl).toBe(300);
  });
});
