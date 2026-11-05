import { describe, expect, test } from "vitest";

import { deleteValueList, getValueList, listValueLists, queryValueList, registerValueList } from "./value-list.ts";

const T1 = { tenantId: "t-1" };
const T2 = { tenantId: "t-2" };

describe("value_list 基础存取（U5 租户作用域）", () => {
  test("注册/覆盖/删除（租户共享）", () => {
    registerValueList({ name: "t_list", description: "测试名单", items: ["a", "b"] }, T1);
    expect(getValueList("t_list", T1)).toEqual({ name: "t_list", description: "测试名单", items: ["a", "b"] });

    registerValueList({ name: "t_list", items: ["c"] }, T1);
    expect(getValueList("t_list", T1)?.items).toEqual(["c"]);

    expect(deleteValueList("t_list", T1)).toBe(true);
  });

  test("listValueLists 支持名称大小写不敏感过滤（限本租户）", () => {
    registerValueList({ name: "Alpha_List", items: [] }, T1);
    registerValueList({ name: "beta-list", items: [] }, T1);
    const names = listValueLists("ALPHA", T1).map((list) => list.name);
    expect(names).toEqual(["Alpha_List"]);
    expect(listValueLists(undefined, T1).length).toBeGreaterThanOrEqual(2);
    deleteValueList("Alpha_List", T1);
    deleteValueList("beta-list", T1);
  });

  test("queryValueList 返回命中结果（list 字段），缺失名单返回 hit=false", () => {
    registerValueList({ name: "t_query", items: ["1.2.3.4"] }, T1);
    expect(queryValueList("t_query", "1.2.3.4", T1)).toEqual({ hit: true, list: "t_query", value: "1.2.3.4" });
    expect(queryValueList("t_query", "5.6.7.8", T1).hit).toBe(false);
    expect(queryValueList("missing_list", "x", T1).hit).toBe(false);
    deleteValueList("t_query", T1);
  });

  test("version 透传（ADR verdict-009 D7：list@version provenance）", () => {
    registerValueList({ name: "t_versioned", items: ["v1"], version: 7 }, T1);
    const hit = queryValueList("t_versioned", "v1", T1);
    expect(hit.version).toBe(7);
    expect(hit.list).toBe("t_versioned");
    const noVersion = queryValueList("t_query", "x", T1);
    expect("version" in noVersion).toBe(false);
    deleteValueList("t_versioned", T1);
  });

  test("Set 物化快照语义：注册后改 items 数组不生效；String 同构比对", () => {
    const items = ["111", "222"];
    registerValueList({ name: "t_snapshot", items }, T1);
    items.push("333"); // 注册后改源数组——快照不受影响
    expect(queryValueList("t_snapshot", "333", T1).hit).toBe(false);
    expect(queryValueList("t_snapshot", 111, T1).hit).toBe(true); // 数字 111 → String 同构命中
    deleteValueList("t_snapshot", T1);
  });

  test("缺 tenantId 的 scope 直接抛错（fail closed）", () => {
    expect(() => registerValueList({ name: "x", items: [] }, { tenantId: "" })).toThrow(/tenantId is required/);
    expect(() => getValueList("x", { tenantId: "" })).toThrow(/tenantId is required/);
  });
});

describe("value_list 租户隔离与可见性（U5）", () => {
  test("自有 > 租户共享 > 不可见他人；跨租户永不可见", () => {
    registerValueList({ name: "o_private_a", items: ["x"] }, { tenantId: "t-1", actor: "user-a" });
    registerValueList({ name: "o_private_b", items: ["y"] }, { tenantId: "t-1", actor: "user-b" });
    registerValueList({ name: "o_shared", items: ["z"] }, { tenantId: "t-1" });
    registerValueList({ name: "o_other_tenant", items: ["w"] }, { tenantId: "t-2" });

    expect(getValueList("o_private_a", { tenantId: "t-1", actor: "user-a" })?.items).toEqual(["x"]);
    expect(getValueList("o_private_a", { tenantId: "t-1", actor: "user-b" })).toBeUndefined();
    expect(getValueList("o_shared", { tenantId: "t-1", actor: "user-b" })).toBeDefined();
    expect(getValueList("o_private_a", T1)).toBeDefined();
    expect(getValueList("o_private_a", T2)).toBeUndefined();
    expect(getValueList("o_other_tenant", T1)).toBeUndefined();

    const visibleB = listValueLists(undefined, { tenantId: "t-1", actor: "user-b" }).map((l) => l.name);
    expect(visibleB).toContain("o_private_b");
    expect(visibleB).toContain("o_shared");
    expect(visibleB).not.toContain("o_private_a");

    deleteValueList("o_private_a", { tenantId: "t-1", actor: "user-a" });
    deleteValueList("o_private_b", { tenantId: "t-1", actor: "user-b" });
    deleteValueList("o_shared", T1);
    deleteValueList("o_other_tenant", T2);
  });

  test("同名遮蔽：自有遮蔽租户共享，删除自有后回落共享", () => {
    registerValueList({ name: "o_shadow", items: ["shared-item"] }, { tenantId: "t-1" });
    registerValueList({ name: "o_shadow", items: ["own-item"] }, { tenantId: "t-1", actor: "user-a" });

    expect(getValueList("o_shadow", { tenantId: "t-1", actor: "user-a" })?.items).toEqual(["own-item"]);
    expect(getValueList("o_shadow", { tenantId: "t-1", actor: "user-b" })?.items).toEqual(["shared-item"]);

    deleteValueList("o_shadow", { tenantId: "t-1", actor: "user-a" });
    expect(getValueList("o_shadow", { tenantId: "t-1", actor: "user-a" })?.items).toEqual(["shared-item"]);
    deleteValueList("o_shadow", T1);
  });

  test("deleteValueList 权限矩阵：私有仅 owner/本租户管理员，共享本租户任意 actor", () => {
    registerValueList({ name: "o_perm_priv", items: [] }, { tenantId: "t-1", actor: "u1" });
    registerValueList({ name: "o_perm_shared", items: [] }, { tenantId: "t-1" });

    expect(deleteValueList("o_perm_priv", { tenantId: "t-1", actor: "u2" })).toBe(false);
    expect(deleteValueList("o_perm_priv", { tenantId: "t-1", actor: "u1" })).toBe(true);
    expect(deleteValueList("o_perm_shared", { tenantId: "t-1", actor: "anyone" })).toBe(true);

    registerValueList({ name: "o_perm_priv", items: [] }, { tenantId: "t-1", actor: "u9" });
    expect(deleteValueList("o_perm_priv", T1)).toBe(true); // 管理员删私有
  });
});
