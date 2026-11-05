import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "vitest";

import { DecisionRuntime } from "./engine.ts";
import { runWithExecContext } from "./exec-context.ts";
import { UdfRegistry } from "./register.ts";

const graph = (id: string) => ({
  id,
  nodes: [
    { id: "in", type: "inputNode", name: "Request" },
    {
      id: "c1",
      type: "customNode",
      name: "custom",
      content: { kind: "UDF", config: { expressions: [{ id: "e1", key: "out", value: "probe_udf;;x" }] } },
    },
    { id: "out", type: "outputNode", name: "Response" },
  ],
  edges: [
    { id: "ed1", sourceId: "in", targetId: "c1", type: "edge" },
    { id: "ed2", sourceId: "c1", targetId: "out", type: "edge" },
  ],
});

const makeRuntime = (otel: boolean): DecisionRuntime => {
  const registry = new UdfRegistry();
  registry.registerFunction(function probe_udf() {
    return { ok: true };
  }, "probe");
  return new DecisionRuntime({ registry, otel });
};

describe("Y6 OTel 桥", () => {
  test("otel: true 时 evaluate 产生根 span，UdfTrace 作为 span events", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);

    const runtime = makeRuntime(true);
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k", graph("g-otel"));
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k", { x: 3 }));
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("zen-udf.evaluate");
    expect(spans[0].attributes["zen-udf.key"]).toBe("k");
    const udfEvents = spans[0].events.filter((e) => e.name === "zen-udf.udf");
    expect(udfEvents.length).toBe(1);
    expect(udfEvents[0].attributes?.["name"]).toBe("probe_udf");
  });

  test("otel 缺省关闭：不产生 span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);

    const runtime = makeRuntime(false);
    await runWithExecContext({ tenantId: "t-1" }, () => {
      runtime.createDecisionWithCacheKey("k2", graph("g-nootel"));
      return Promise.resolve();
    });
    await runWithExecContext({ tenantId: "t-1" }, () => runtime.evaluateAsync("k2", { x: 1 }));
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().length).toBe(0);
  });
});
