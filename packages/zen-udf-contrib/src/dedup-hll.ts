// dedup-hll 参考域：长窗口/大基数的去重基数（HLL 承载，~0.81% 误差，内存 O(1)/键）。
// 与 HAProxy 档分工：短窗聚集+节拍+delta（HAProxy）/ 长窗全域去重基数（本域，
// 可合并分布式原生——本地 sketch 低频合并全局，per-event 零集中写）。
// 语义声明边界：只出基数——无 delta（union-only 代数差分推不出）、无 idle（无
// 时间戳）、无 membership（无成员枚举）。
import { tool } from "@republicroad/zen-udf";
import { Type } from "@sinclair/typebox";

import { Hll } from "./hll.ts";

/** HLL 存储：键 → sketch（进程内；分布式形态=本地 sketch 低频合并全局 blob） */
export interface DedupHllStore {
  /** 向键的 sketch 添加成员并返回当前基数（近似 ~0.8%） */
  tally(key: string, member: string): number;
  /** 只读基数 */
  count(key: string): number;
}

/** 进程内 HLL 存储（单实例语义；条目惰性过期由窗口校验承载） */
export class InMemoryDedupHllStore implements DedupHllStore {
  private readonly sketches = new Map<string, { hll: Hll; createdAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private sketch(key: string, reset = false): Hll {
    const now = this.now();
    const entry = this.sketches.get(key);
    if (reset || !entry || now - entry.createdAt >= this.windowMs) {
      const fresh = { hll: new Hll(), createdAt: now };
      this.sketches.set(key, fresh);
      return fresh.hll;
    }
    return entry.hll;
  }

  tally(key: string, member: string): number {
    const hll = this.sketch(key);
    hll.add(member);
    return hll.count();
  }

  count(key: string): number {
    return this.sketch(key).count();
  }
}

export interface DedupHllToolOptions {
  /** 窗口（缺省 7d——HLL 领地为长窗口/全域） */
  windowMs?: number;
  /** 误差 ~0.8%：断言用范围而非精确值 */
}

export const createDedupHllTools = (store: DedupHllStore) => {
  const dedupHllTally = tool({
    namespace: "dedup-hll",
    name: "dedup_hll_tally",
    description:
      "去重基数（HLL 近似 ~0.8%）：向键的 sketch 添加个体并返回窗口内去重基数。" +
      "长窗口/大基数领地（内存 O(1)/键，30d/90d/全域不涨）；无 delta/idle/membership" +
      "（语义=去重总量计数；短窗聚集+节拍用 cluster_probe，审计级精确用 velocity）。",
    semantics: "observe",
    temporal: "processing",
    stateful: true,
    fidelity: "sketch",
    input: Type.Object({
      key: Type.String({ title: "去重键", description: "聚合主体（如 device:30d）" }),
      member: Type.String({ title: "成员", description: "去重个体（如 accountId）" }),
    }),
    output: Type.Object({
      count: Type.Integer({ title: "去重基数（近似）" }),
    }),
    run: async (kwargs: { key?: unknown; member?: unknown }) => {
      const count = store.tally(String(kwargs?.key ?? ""), String(kwargs?.member ?? ""));
      return { count };
    },
  });

  const dedupHllCount = tool({
    namespace: "dedup-hll",
    name: "dedup_hll_count",
    description: "去重基数只读（不添加成员）。",
    semantics: "query",
    temporal: "processing",
    stateful: true,
    fidelity: "sketch",
    input: Type.Object({
      key: Type.String({ title: "去重键" }),
    }),
    output: Type.Object({
      count: Type.Integer({ title: "去重基数（近似）" }),
    }),
    run: async (kwargs: { key?: unknown }) => {
      const count = store.count(String(kwargs?.key ?? ""));
      return { count };
    },
  });

  return [dedupHllTally, dedupHllCount] as const; // 显式元组：避免联合数组推断丢失各 run 参数类型
};
