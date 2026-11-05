import { DecisionRuntime, runWithExecContext } from "@republicroad/zen-udf";

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";



import { deleteRoster, registerRoster } from "../value-list.ts";
import "./custom-list-query.ts";
import "./ip-location.ts";
import { __resetRateWindows } from "@republicroad/zen-udf";
import "../trailing-window.ts";

/**
 * 第六十九批 D2 闭环验收：撞库攻击防御.json 仿真恢复。
 * 该图 4 个 UDF 节点依赖 custom_list_query / ip_location / rate_1h / group_distinct_1h
 * （docs/13 §7.3：此前验收降级为加载/渲染/编辑，仿真因 udf not found 暂缓）。
 */
const GRAPH = path.resolve(import.meta.dirname, "../../graph/撞库攻击防御.json");
const LIST_NAME = "熊猫ip白名单";
const ACTOR = "acceptance-user";

describe("撞库攻击防御.json 仿真验收（第六十九批 D2 闭环）", () => {
  test("白名单命中路径：无 udf not found，custom_list_query result:true", async () => {
    __resetRateWindows();
    registerRoster({ name: LIST_NAME, items: ["8.8.8.8"] }, { tenantId: "acceptance-tenant", actor: ACTOR });
    const content = JSON.parse(readFileSync(GRAPH, "utf8")) as unknown;
    const zr = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "acceptance-tenant", userId: ACTOR }, async () =>
      zr.createDecisionWithCacheKey("chuangku-hit", JSON.stringify(content)),
    );

    const result = (await runWithExecContext({ tenantId: "acceptance-tenant", userId: ACTOR }, () =>
      zr.evaluateAsync("chuangku-hit", { ip: "8.8.8.8", phone: "13800000000" }, { trace: true }),
    )) as { result?: { reason?: string }; performance?: string };
    const s = JSON.stringify(result);

    expect(s).not.toContain("udf not found");
    // 命中语义：最终 reason 由白名单查询结果驱动（"ip白名单,通过"）
    expect(result.result?.reason ?? "").toContain("白名单");
    // custom_list_query 输出 {result:true} 进入 trace
    expect(s).toContain('"result":true');
    deleteRoster(LIST_NAME, { tenantId: "acceptance-tenant", actor: ACTOR });
  });

  test("非白名单路径：频控/组去重/属地函数全部解析执行", async () => {
    __resetRateWindows();
    registerRoster({ name: LIST_NAME, items: ["8.8.8.8"] }, { tenantId: "acceptance-tenant", actor: ACTOR });
    const content = JSON.parse(readFileSync(GRAPH, "utf8")) as unknown;
    const zr = new DecisionRuntime({});
    await runWithExecContext({ tenantId: "acceptance-tenant", userId: ACTOR }, async () =>
      zr.createDecisionWithCacheKey("chuangku-miss", JSON.stringify(content)),
    );

    const result = (await runWithExecContext({ tenantId: "acceptance-tenant", userId: ACTOR }, () =>
      zr.evaluateAsync("chuangku-miss", { ip: "9.9.9.9", phone: "13900000000" }, { trace: true }),
    )) as unknown as Record<string, unknown>;
    const s = JSON.stringify(result);

    expect(s).not.toContain("udf not found");
    // 指标计算节点（非白名单路径）的 UDF 输出进入 trace：rate 计数与组去重 pv
    expect(s).toContain('"counter":1');
    expect(s).toContain('"pv":1');
    // ip_location 空 dataset 回退：字段齐全 + ip 回显
    expect(s).toContain('"ip":"9.9.9.9"');
    deleteRoster(LIST_NAME, { tenantId: "acceptance-tenant", actor: ACTOR });
  });
});
