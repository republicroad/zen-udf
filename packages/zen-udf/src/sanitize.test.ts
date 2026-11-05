import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

const graph = {
  id: "g-sanitize",
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: "boom_udf" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
};

const evalOut = async (runtime: DecisionRuntime): Promise<string | undefined> => {
  const result = await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", {}));
  return (result.result as { out?: { error?: string } }).out?.error;
};

describe("V4 表达式错误脱敏（§6.7）", () => {
  test("内置规则：绝对路径占位 + 敏感环境变量值替换", async () => {
    process.env.ZUDF_TEST_SECRET = "supersecret42";
    const registry = new UdfRegistry();
    registry.registerFunction(function boom_udf() {
      throw new Error("read failed at C:\\Users\\op\\secret.txt with token supersecret42");
    }, "target");
    const runtime = new DecisionRuntime({ registry });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph);
      return Promise.resolve();
    });

    const error = await evalOut(runtime);
    expect(error).toBeDefined();
    expect(error).not.toContain("C:\\Users\\op\\secret.txt");
    expect(error).not.toContain("supersecret42");
    expect(error).toContain("[path]");
    expect(error).toContain("[ZUDF_TEST_SECRET]");
    delete process.env.ZUDF_TEST_SECRET;
  });

  test("可注入脱敏器替换内置规则", async () => {
    const registry = new UdfRegistry();
    registry.registerFunction(function boom_udf() {
      throw new Error("plain message");
    }, "target");
    const runtime = new DecisionRuntime({ registry, sanitizer: () => "[redacted]" });
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph);
      return Promise.resolve();
    });

    expect(await evalOut(runtime)).toBe("[redacted]");
  });
});
