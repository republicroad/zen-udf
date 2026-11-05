import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { createUdfRuntime, type UdfPack, validatePack } from "./register.ts";

const fraudPack: UdfPack = {
  namespace: "fraud",
  tools: [
    {
      name: "device_fingerprint_query",
      description: "设备指纹查询（探针）",
      parametersSchema: {
        properties: { deviceId: { type: "string", title: "DeviceId" } },
        required: ["deviceId"],
        title: "device_fingerprint_query",
        type: "object",
      },
      returnsSchema: { type: "object", title: "result", properties: {} },
      fn: function deviceFingerprintQueryUdf(kwargs: Record<string, unknown>) {
        return { deviceId: kwargs?.deviceId ?? null, marker: "fraud-pack" };
      },
    },
  ],
};

describe("UdfPack 契约（U6）", () => {
  test("validatePack：合法包通过", () => {
    expect(validatePack(fraudPack)).toEqual([]);
  });

  test("validatePack：缺 namespace / 空 tools / 缺 fn / 重名 / 缺 properties 逐项报错", () => {
    const errors = validatePack({
      namespace: "",
      tools: [
        { name: "", fn: () => null },
        { name: "t1", fn: "not-a-fn" as unknown as () => null },
        {
          name: "t2",
          fn: () => null,
          parametersSchema: { title: "no-properties", type: "object" } as never,
        },
        { name: "t2", fn: () => null },
      ],
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join("\n")).toContain("namespace is required");
    expect(errors.join("\n")).toContain("tool 't1' requires a function fn");
    expect(errors.join("\n")).toContain("duplicate tool name 't2'");
  });

  test("createUdfRuntime：pack 注册 → schema 下发 → 调用 round-trip", async () => {
    const registry = createUdfRuntime({ packs: [fraudPack] });

    const schema = registry.udfFunctionSchema("device_fingerprint_query");
    expect(schema?.namespace).toBe("fraud");
    expect(schema?.parametersSchema?.properties?.["deviceId"]).toBeDefined();

    const namespaces = registry.udfFunctionSchemaNamespaces();
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]).toMatchObject({ name: "fraud", title: "fraud", type: "namespace" });
    expect(namespaces[0].tools[0]).toMatchObject({ name: "device_fingerprint_query", kind: "fraud" });

    const bound = registry.funcBindParams("device_fingerprint_query", ["dev-1"]);
    const result = (await registry.call("device_fingerprint_query", bound)) as { marker: string };
    expect(result.marker).toBe("fraud-pack");
  });

  test("Y1 semantics：无效语义被 validatePack 拒绝，合法语义透传下发", () => {
    const errors = validatePack({
      namespace: "ns",
      tools: [{ name: "t", fn: () => null, semantics: "effect" as never }],
    });
    expect(errors.join("; ")).toContain("semantics must be one of query/observe/act");

    const registry = createUdfRuntime({
      packs: [{ namespace: "obs", tools: [{ name: "counter", fn: () => 1, semantics: "observe" }] }],
    });
    expect(registry.udfFunctionSchema("counter")?.semantics).toBe("observe");
    expect(registry.udfFunctionSchemaNamespaces()[0].tools[0].semantics).toBe("observe");
  });

  test("createUdfRuntime：非法 pack 整体失败且不产生半注册状态", () => {
    const badPack: UdfPack = { namespace: "bad", tools: [{ name: "t", fn: undefined as never }] };
    expect(() => createUdfRuntime({ packs: [badPack] })).toThrow(/invalid UdfPack 'bad'/);
  });

  test("pack 注入的注册表 + DecisionRuntime 端到端执行", async () => {
    const registry = createUdfRuntime({ packs: [fraudPack] });
    const runtime = new DecisionRuntime({ registry });
    const graph = {
      id: "g-pack",
      nodes: [
        { id: "in", type: "inputNode", name: "Request" },
        {
          id: "c1",
          type: "customNode",
          name: "custom",
          content: {
            kind: "UDF",
            config: { expressions: [{ id: "e1", key: "fp", value: "device_fingerprint_query;;deviceId" }] },
          },
        },
        { id: "out", type: "outputNode", name: "Response" },
      ],
      edges: [
        { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
        { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
      ],
    };

    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("fraud-model", graph, "v1");
      return Promise.resolve();
    });
    const result = await runWithExecContext({ tenantId: "t-1" }, () =>
      runtime.evaluateAsync("fraud-model", { deviceId: "dev-9" }, undefined, "v1"),
    );
    expect((result.result as { fp: { marker: string } }).fp.marker).toBe("fraud-pack");
  });
});
