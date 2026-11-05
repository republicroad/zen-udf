import { globalUdfRegistry, runWithExecContext } from "@republicroad/zen-udf";

import { describe, expect, test } from "vitest";



import { registerRoster } from "../value-list.ts";
import "./custom-list-query.ts";
import "./ip-location.ts";
import "../trailing-window.ts";
import { __resetRateWindows } from "@republicroad/zen-udf";

const call = <T>(name: string, args: unknown[]): Promise<T> =>
  globalUdfRegistry.call(name, globalUdfRegistry.funcBindParams(name, args)) as Promise<T>;

describe("custom_list_query（D2 重建）", () => {
  test("名单命中返回 result:true，未命中 false（actor 隔离）", async () => {
    registerRoster({ name: "clq_list", items: ["v-hit"] }, { tenantId: "clq-tenant", actor: "clq-user" });
    const hit = await runWithExecContext({ tenantId: "clq-tenant", userId: "clq-user" }, () =>
      call<{ result: boolean }>("custom_list_query", ["clq_list", "v-hit"]),
    );
    const miss = await runWithExecContext({ tenantId: "clq-tenant", userId: "clq-user" }, () =>
      call<{ result: boolean }>("custom_list_query", ["clq_list", "v-miss"]),
    );
    expect(hit.result).toBe(true);
    expect(miss.result).toBe(false);
  });
});

describe("rate_1h / group_distinct_1h（D2 重建，内存滑动窗口）", () => {
  test("同实体计数递增，异实体独立", async () => {
    __resetRateWindows();
    const a1 = await call<{ counter: number; v: string; timestamp: string }>("rate_1h", ["1.1.1.1"]);
    const a2 = await call<{ counter: number; v: string; timestamp: string }>("rate_1h", ["1.1.1.1"]);
    const b1 = await call<{ counter: number; v: string; timestamp: string }>("rate_1h", ["2.2.2.2"]);
    expect(a1.counter).toBe(1);
    expect(a2.counter).toBe(2);
    expect(b1.counter).toBe(1);
    expect(typeof a1.timestamp).toBe("string");
  });

  test("group_distinct_1h：pv 累计、uv 按值去重、组间独立", async () => {
    __resetRateWindows();
    const r1 = await call<{ pv: number; uv: number }>("group_distinct_1h", ["g-ip", "p1"]);
    const r2 = await call<{ pv: number; uv: number }>("group_distinct_1h", ["g-ip", "p1"]);
    const r3 = await call<{ pv: number; uv: number }>("group_distinct_1h", ["g-ip", "p2"]);
    const other = await call<{ pv: number; uv: number }>("group_distinct_1h", ["g-other", "p1"]);
    expect(r1.pv).toBe(1);
    expect(r1.uv).toBe(1);
    expect(r2.pv).toBe(2);
    expect(r2.uv).toBe(1);
    expect(r3.uv).toBe(2);
    expect(other.pv).toBe(1);
  });

  test("ip_location：数据集最长前缀命中，未配置返回空字段", async () => {
    __resetRateWindows();
    const miss = await call<{ country: string; ip: string }>("ip_location", ["9.9.9.9"]);
    expect(miss.country).toBe("");
    expect(miss.ip).toBe("9.9.9.9");
  });
});
