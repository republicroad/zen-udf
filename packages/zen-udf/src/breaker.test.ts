import { describe, expect, test } from "vitest";

import { InMemoryCircuitBreaker, NoopCircuitBreaker } from "./breaker.ts";

describe("InMemoryCircuitBreaker（Y5）", () => {
  test("连续失败达阈值 → 打开 → openMs 后半开放行", async () => {
    let now = 1_000_000;
    const breaker = new InMemoryCircuitBreaker(2, 100, () => now);

    expect(breaker.allow("k")).toBe(true);
    breaker.recordFailure("k");
    expect(breaker.allow("k")).toBe(true);
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true); // 达阈值打开

    now += 50;
    expect(breaker.isOpen("k")).toBe(true); // 仍在打开期

    now += 60;
    expect(breaker.allow("k")).toBe(true); // 半开放行探测
    breaker.recordSuccess("k"); // 探测成功 → 关闭
    expect(breaker.isOpen("k")).toBe(false);
    expect(breaker.allow("k")).toBe(true);
  });

  test("半开探测失败 → 重新打开", async () => {
    let now = 2_000_000;
    const breaker = new InMemoryCircuitBreaker(1, 100, () => now);
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true);

    now += 200; // 超过 openMs → 半开
    expect(breaker.allow("k")).toBe(true);
    breaker.recordFailure("k");
    now += 50;
    expect(breaker.isOpen("k")).toBe(true); // 重新打开
  });

  test("成功清零失败连击", () => {
    const breaker = new InMemoryCircuitBreaker(2, 100, () => 3_000_000);
    breaker.recordFailure("k");
    breaker.recordSuccess("k");
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(false);
  });

  test("NoopCircuitBreaker 恒放行", () => {
    const breaker = new NoopCircuitBreaker();
    expect(breaker.allow("k")).toBe(true);
    breaker.recordFailure("k");
    expect(breaker.allow("k")).toBe(true);
  });
});
