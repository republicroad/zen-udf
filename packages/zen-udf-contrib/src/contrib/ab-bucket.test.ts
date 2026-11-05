import { describe, expect, test } from "vitest";

import { abBucket, fnv1a } from "./ab-bucket.ts";

describe("fnv1a 哈希", () => {
  test("同 key 恒同值；不同 key 大概率不同值", () => {
    expect(fnv1a("user-1")).toBe(fnv1a("user-1"));
    expect(fnv1a("user-1")).not.toBe(fnv1a("user-2"));
  });

  test("返回 32 位无符号整数", () => {
    const v = fnv1a("anything");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("ab_bucket 分桶", () => {
  test("稳定分桶且落在 [0, buckets)", () => {
    for (let i = 0; i < 50; i += 1) {
      const key = `key-${i}`;
      const first = abBucket({ key, buckets: 5 }) as number;
      const second = abBucket({ key, buckets: 5 }) as number;
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(5);
    }
  });

  test("buckets 非法回退 2", () => {
    const b = abBucket({ key: "k", buckets: 0 }) as number;
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(2);
  });
});
