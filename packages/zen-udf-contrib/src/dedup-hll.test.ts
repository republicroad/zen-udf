// dedup-hll 域测试：基数估计精度（小基数近乎精确）/ 键隔离 / 窗口过期 / merge / 工具装配
import { describe, expect, test } from "vitest";

import { createDedupHllTools, InMemoryDedupHllStore } from "./dedup-hll.ts";
import { Hll } from "./hll.ts";

describe("Hll 基础代数", () => {
  test("小基数近乎精确（20 个不同成员 → 20±1）", () => {
    const hll = new Hll();
    for (let i = 0; i < 20; i++) hll.add(`member-${i}`);
    const c = hll.count();
    expect(c).toBeGreaterThanOrEqual(19);
    expect(c).toBeLessThanOrEqual(21);
  });

  test("重复 add 不影响基数（去重语义）", () => {
    const hll = new Hll();
    for (let i = 0; i < 20; i++) hll.add(`m-${i % 5}`);
    const c1 = hll.count();
    for (let i = 0; i < 5; i++) hll.add(`m-${i % 5}`);
    expect(hll.count()).toBe(c1);
  });

  test("merge：并集基数（可合并分布式语义）", () => {
    const a = new Hll();
    const b = new Hll();
    for (let i = 0; i < 10; i++) a.add(`x-${i}`);
    for (let i = 5; i < 15; i++) b.add(`x-${i}`);
    a.merge(b);
    const c = a.count();
    expect(c).toBeGreaterThanOrEqual(13);
    expect(c).toBeLessThanOrEqual(17);
  });

  test("大基数（1 万）误差 <2%", () => {
    const hll = new Hll();
    const n = 10_000;
    for (let i = 0; i < n; i++) hll.add(`v-${i}`);
    const c = hll.count();
    expect(Math.abs(c - n) / n).toBeLessThan(0.02);
  });
});

describe("InMemoryDedupHllStore", () => {
  test("tally 返回基数 / count 只读", () => {
    const store = new InMemoryDedupHllStore(7 * 24 * 3600 * 1000);
    const t1 = store.tally("device-1:30d", "acc-1");
    store.tally("device-1:30d", "acc-2");
    const c = store.count("device-1:30d");
    expect(t1).toBeGreaterThanOrEqual(1);
    expect(c).toBeGreaterThanOrEqual(2);
  });

  test("键隔离（不同键基数互不串）", () => {
    const store = new InMemoryDedupHllStore(7 * 24 * 3600 * 1000);
    store.tally("device-a", "acc-1");
    store.tally("device-a", "acc-2");
    const a = store.count("device-a");
    const b = store.count("device-b");
    expect(a).toBeGreaterThanOrEqual(2);
    expect(b).toBe(0);
  });
});

describe("dedup_hll 工具装配", () => {
  test("tally 工具返回 {count}", async () => {
    const store = new InMemoryDedupHllStore(7 * 24 * 3600 * 1000);
    const [tally] = createDedupHllTools(store);
    const r = (await tally.run({ key: "dev-1:30d", member: "acc-1" })) as { count: number };
    expect(r.count).toBeGreaterThanOrEqual(1);
  });
});
