import { describe, expect, test } from "vitest";

import type { RateStore } from "./rate-store.ts";

/**
 * RateStore 契约测试（U8；ADR-021 §1.4 分档）：任何 RateStore 实现（含 verdict 侧
 * Redis 实现）都应用本套件验证同一行为语义。工厂接收可注入时钟 now()——实现应
 * 使用该时钟打点（Redis 实现可将 now() 的时间戳随命令传入，而非依赖服务器时钟）。
 *
 * 分档（ADR-021 §1.4）：实现按通过档位获许可（live-only / live+replay）——
 * - exact（缺省）：全向量严格断言（asOf point-in-time 在套件）+ **重试双计向量**
 *   （ADR-021 预评审核查 3 修正：exact 档唯一新增）；
 * - approximate：同向量 + ε 容差（epsilon，缺省 1——桶近似/双桶插值的读数差异）
 *   + 单调性豁免（滑窗精确复位类断言按 ε 放宽）。
 */
export interface RateConformanceOptions {
  /** 档位：exact（缺省，live+replay 许可）/ approximate（live-only，ε 容差） */
  mode?: "exact" | "approximate";
  /** approximate 档数值断言容差（|actual-expected| ≤ epsilon），缺省 1 */
  epsilon?: number;
}

export const rateStoreConformance = (
  name: string,
  createStore: (now: () => number) => RateStore,
  options: RateConformanceOptions = {},
): void => {
  const exact = (options.mode ?? "exact") === "exact";
  const eps = options.epsilon ?? 1;
  describe(`RateStore conformance: ${name} (${exact ? "exact" : `approximate ±${eps}`})`, () => {
    let nowMs = 1_700_000_000_000;
    let store: RateStore;

    const advance = (ms: number): void => {
      nowMs += ms;
    };
    /** 档位感知数值断言：exact 恒等；approximate ±epsilon（单调性/读数容差） */
    const expectNum = (actual: number, expected: number): void => {
      if (exact) expect(actual).toBe(expected);
      else expect(Math.abs(actual - expected)).toBeLessThanOrEqual(eps);
    };

    test("rate：首次计数 1、递增、实体间独立", async () => {
      store = createStore(() => nowMs);
      const a1 = await store.rate("ip-a", 3_600_000);
      const a2 = await store.rate("ip-a", 3_600_000);
      const b1 = await store.rate("ip-b", 3_600_000);
      expectNum(a1.counter, 1);
      expectNum(a2.counter, 2);
      expectNum(b1.counter, 1);
      expect(a1.v).toBe("ip-a");
      expectNum(a1.idle, 0);
      expect(typeof a1.timestamp).toBe("string");
    });

    test("rate：窗口滑出后计数重置，idle 为距上次事件秒数", async () => {
      nowMs = 1_700_000_000_000;
      store = createStore(() => nowMs);
      await store.rate("ip-w", 60_000);
      advance(30_000);
      const second = await store.rate("ip-w", 60_000);
      expectNum(second.counter, 2);
      expectNum(second.idle, 30);
      advance(61_000); // 两次事件均滑出 60s 窗口
      const third = await store.rate("ip-w", 60_000);
      expectNum(third.counter, 1);
    });

    test("groupDistinct：pv 累计、uv 按值去重、组间独立", async () => {
      nowMs = 1_800_000_000_000;
      store = createStore(() => nowMs);
      const r1 = await store.groupDistinct("g-ip", "p1", 3_600_000);
      const r2 = await store.groupDistinct("g-ip", "p1", 3_600_000);
      const r3 = await store.groupDistinct("g-ip", "p2", 3_600_000);
      const other = await store.groupDistinct("g-other", "p1", 3_600_000);
      expectNum(r1.pv, 1);
      expectNum(r1.uv, 1);
      expectNum(r2.pv, 2);
      expectNum(r2.uv, 1);
      expectNum(r3.pv, 3);
      expectNum(r3.uv, 2);
      expectNum(other.pv, 1);
      expect(other.group).toBe("g-other");
      expect(other.v).toBe("p1");
    });

    test("rate/groupDistinct：asOf 事件时间锚点（point-in-time 复算）", async () => {
      nowMs = 2_100_000_000_000;
      store = createStore(() => nowMs);
      await store.rate("ip-asof", 60_000);
      const atPlus30 = await store.rate("ip-asof", 60_000, nowMs + 30_000);
      expectNum(atPlus30.counter, 2);
      expectNum(atPlus30.idle, 30);
      const atPlus61 = await store.rate("ip-asof", 60_000, nowMs + 61_000);
      // 窗口随 asOf 平移：事件1(nowMs) 滑出，事件2(nowMs+30s) 仍在窗内，本次调用自身计入 → 2
      expectNum(atPlus61.counter, 2);

      const g1 = await store.groupDistinct("g-asof", "v1", 60_000, nowMs + 90_000);
      const g2 = await store.groupDistinct("g-asof", "v2", 60_000, nowMs + 90_000);
      expectNum(g1.pv, 1);
      expectNum(g1.uv, 1);
      expectNum(g2.pv, 2);
      expectNum(g2.uv, 2);
    });

    test("groupDistinct：窗口滑出后 pv/uv 重置", async () => {
      nowMs = 1_900_000_000_000;
      store = createStore(() => nowMs);
      await store.groupDistinct("g-w", "v1", 60_000);
      await store.groupDistinct("g-w", "v2", 60_000);
      advance(61_000);
      const after = await store.groupDistinct("g-w", "v3", 60_000);
      expectNum(after.pv, 1);
      expectNum(after.uv, 1);
    });

    test("重试双计向量（ADR-021 §1.3 exact 档唯一新增）：rate 为 INCR 形态——同参重试按两次事件计，pv 双计 uv 不双计", async () => {
      nowMs = 2_200_000_000_000;
      store = createStore(() => nowMs);
      // 重试场景：同一 (entity, window) 的第二次调用（模拟超时重试）→ counter 恒递增。
      // 本向量把「rate 非幂等」钉进契约：调用方对 stateful 工具 MUST NOT 自动重试
      // （ADR-021 §1.3 禁重试缺省 + ExecContext.requestId 幂等键单源——存储级去重
      // 属可选增强，签名扩展不在第一批）。
      const first = await store.rate("ip-retry", 3_600_000);
      const retried = await store.rate("ip-retry", 3_600_000);
      expectNum(first.counter, 1);
      expectNum(retried.counter, 2);
      // groupDistinct：pv 事件数双计，uv 去重值不双计
      const g1 = await store.groupDistinct("g-retry", "v", 3_600_000);
      const g2 = await store.groupDistinct("g-retry", "v", 3_600_000);
      expectNum(g1.pv, 1);
      expectNum(g1.uv, 1);
      expectNum(g2.pv, 2);
      expectNum(g2.uv, 1);
    });
  });
};
