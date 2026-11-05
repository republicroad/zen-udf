import { describe, expect, test } from "vitest";

import { UdfRegistry } from "./register.ts";

describe("UdfRegistry namespace collision（U3 起跨名硬失败）", () => {
  test("函数名与自身 namespace 同名放行（遗留契约：namespace 优先）", () => {
    const manager = new UdfRegistry();
    expect(() => manager.registerFunction(() => null, "roster", undefined, "roster")).not.toThrow();
    expect(manager.udfFunctionSchema("roster")?.namespace).toBe("roster");
  });

  test("函数名与现有 namespace 同名时抛错", () => {
    const manager = new UdfRegistry();
    manager.registerFunction(() => null, "counter", undefined, "rate_1h");
    expect(() => manager.registerFunction(() => null, "debug", undefined, "counter")).toThrow(/'counter'/);
  });

  test("namespace 与现有函数同名时抛错", () => {
    const manager = new UdfRegistry();
    manager.registerFunction(() => null, "debug", undefined, "roster");
    expect(() => manager.registerFunction(() => null, "roster", undefined, "query_list")).toThrow(/namespace 'roster'/);
  });

  test("force 逃生口可显式接管撞名", () => {
    const manager = new UdfRegistry();
    manager.registerFunction(() => null, "counter", undefined, "rate_1h");
    expect(() => manager.registerFunction(() => null, "debug", undefined, "counter", { force: true })).not.toThrow();
    expect(manager.udfFunctionSchema("counter")).toBeDefined();
  });

  test("无碰撞时正常注册", () => {
    const manager = new UdfRegistry();
    expect(() => manager.registerFunction(() => null, "debug", undefined, "inout")).not.toThrow();
  });

  test("registerTools 批量注册到指定 namespace", () => {
    const manager = new UdfRegistry();
    manager.registerTools(
      [
        {
          name: "tool_a",
          description: "a",
          parametersSchema: { properties: {}, title: "tool_a", type: "object" },
          returnsSchema: { type: "null" },
          fn: () => 1,
        },
        {
          name: "tool_b",
          description: "b",
          parametersSchema: { properties: {}, title: "tool_b", type: "object" },
          returnsSchema: { type: "null" },
          fn: () => 2,
        },
      ],
      "pack-ns",
    );
    expect(manager.udfFunctionSchema("tool_a")?.namespace).toBe("pack-ns");
    expect(manager.udfFunctionSchema("tool_b")?.namespace).toBe("pack-ns");
  });
});

describe("deprecated 标记透传（WS2 批 2 A4）", () => {
  test("registerTools 的 deprecated 经 normalize 抵达 namespaces 载荷", () => {
    const manager = new UdfRegistry();
    manager.registerTools(
      [
        {
          name: "legacy_hash",
          description: "旧版摘要",
          deprecated: { since: "0.6.0", note: "请改用 crypto 函数" },
          parametersSchema: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
          fn: () => "x",
        },
      ],
      "demo",
    );

    const tool = manager
      .udfFunctionSchemaNamespaces()
      .find((ns) => ns.name === "demo")
      ?.tools.find((t) => t.name === "legacy_hash");

    expect(tool?.deprecated).toEqual({ since: "0.6.0", note: "请改用 crypto 函数" });
  });
});
