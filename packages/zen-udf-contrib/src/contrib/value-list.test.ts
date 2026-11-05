import { globalUdfRegistry, runWithExecContext } from "@republicroad/zen-udf";

import { describe, expect, test } from "vitest";



import { deleteValueList, registerValueList } from "../value-list.ts";
import "./value-list.ts";

describe("value_list UDF（新旧名双注册）", () => {
  test("并发双 ctx 下各自命中 actor 私有名单", async () => {
    registerValueList({ name: "o_udf_a", items: ["ip-a"] }, { tenantId: "roster-tenant", actor: "udf-user-a" });
    registerValueList({ name: "o_udf_b", items: ["ip-b"] }, { tenantId: "roster-tenant", actor: "udf-user-b" });

    const call = () =>
      globalUdfRegistry.call("roster", globalUdfRegistry.funcBindParams("roster", ["o_udf_a", "ip-a"])) as Promise<{
        hit: boolean;
      }>;
    // 新名直调（list 参数）：与旧名 alias 同一查询核心
    const callNew = () =>
      globalUdfRegistry.call(
        "value_list",
        globalUdfRegistry.funcBindParams("value_list", ["o_udf_a", "ip-a"]),
      ) as Promise<{
        hit: boolean;
      }>;
    const [asA, asB] = await Promise.all([
      runWithExecContext({ tenantId: "roster-tenant", userId: "udf-user-a" }, call),
      runWithExecContext({ tenantId: "roster-tenant", userId: "udf-user-b" }, call),
    ]);
    const [newAsA] = await Promise.all([
      runWithExecContext({ tenantId: "roster-tenant", userId: "udf-user-a" }, callNew),
    ]);
    expect(newAsA.hit).toBe(true); // 新旧名同 store——新名查 udf-user-a 私有名单同命中
    expect(asA.hit).toBe(true);
    expect(asB.hit).toBe(false);

    deleteValueList("o_udf_a", { tenantId: "roster-tenant", actor: "udf-user-a" });
    deleteValueList("o_udf_b", { tenantId: "roster-tenant", actor: "udf-user-b" });
  });
});
