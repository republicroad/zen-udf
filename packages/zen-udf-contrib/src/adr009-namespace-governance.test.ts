import { describe, expect, test } from "vitest";

import { loadReferenceInto } from "./reference.ts";
import {
  type ContribToolDef,
  createUdfRuntime,
  reservedNamespaceViolation,
  type UdfPack,
  validatePack,
} from "@republicroad/zen-udf";

const tool = (name: string, value: unknown = {}): ContribToolDef => ({
  name,
  description: `${name} test tool`,
  parametersSchema: { type: "object", properties: {}, title: name },
  returnsSchema: { type: "object", properties: {} },
  fn: () => value,
});

const pack = (namespace: string, tools: UdfPack["tools"], meta?: UdfPack["meta"]): UdfPack => ({
  namespace,
  tools,
  ...(meta ? { meta } : {}),
});

describe("ADR-009 namespace 立法", () => {
  test("保留前缀：zen/core/reference/builtin 精确名与点分前缀均拒绝，zenkit/verdict.risk 放行", () => {
    expect(reservedNamespaceViolation("zen")).toMatch(/reserved prefix 'zen'/);
    expect(reservedNamespaceViolation("core")).toMatch(/reserved prefix 'core'/);
    expect(reservedNamespaceViolation("reference")).toMatch(/reserved prefix 'reference'/);
    expect(reservedNamespaceViolation("builtin")).toMatch(/reserved prefix 'builtin'/);
    expect(reservedNamespaceViolation("zen.ext")).toMatch(/reserved prefix 'zen'/);
    expect(reservedNamespaceViolation("zenkit")).toBeNull();
    expect(reservedNamespaceViolation("verdict.risk")).toBeNull();
    expect(validatePack(pack("zen.risk", [tool("t")]))[0]).toMatch(/reserved prefix/);
    expect(() => createUdfRuntime({ packs: [pack("core", [tool("t")])] })).toThrow(/reserved prefix/);
  });

  test("跨 namespace 函数名撞名 → deploy 期失败，报错列出已注册来源 namespace", () => {
    const err = (() => {
      try {
        createUdfRuntime({
          packs: [pack("crypto", [tool("hash")]), pack("risk", [tool("hash")])],
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toMatch(/tool 'hash' already registered by namespace 'crypto'/);
  });

  test("overwrite: true 显式接管——不报错且后注册者生效", () => {
    const registry = createUdfRuntime({
      packs: [
        pack("crypto", [tool("hash", { from: "crypto" })]),
        pack("risk", [{ ...tool("hash", { from: "risk" }), overwrite: true }]),
      ],
    });
    const namespaces = registry.udfFunctionSchemaNamespaces();
    const risk = namespaces.find((ns) => ns.name === "risk");
    expect(risk?.tools.some((t) => t.name === "hash")).toBe(true);
  });

  test("pack namespace 重复 → 失败（配置错误）", () => {
    expect(() => createUdfRuntime({ packs: [pack("dupe", [tool("a")]), pack("dupe", [tool("b")])] })).toThrow(
      /duplicate pack namespace 'dupe'/,
    );
  });
});

describe("ADR-009 UdfPackMeta", () => {
  test("meta 形状校验：origin 取值域/version 必填/license 取值域", () => {
    expect(validatePack(pack("ns", [tool("t")], { origin: "galaxy" as never, version: "1" }))[0]).toMatch(
      /meta\.origin/,
    );
    expect(validatePack(pack("ns", [tool("t")], { origin: "industry", version: "" }))[0]).toMatch(/meta\.version/);
    expect(
      validatePack(pack("ns", [tool("t")], { origin: "industry", version: "1", license: "gpl" as never }))[0],
    ).toMatch(/meta\.license/);
    expect(validatePack(pack("ns", [tool("t")], { origin: "industry", version: "1" }))).toEqual([]);
  });

  test("meta 随 udfFunctionSchemaNamespaces 透传；无 meta 的 namespace 不带该字段", () => {
    const registry = createUdfRuntime({
      packs: [
        pack("risk", [tool("score")], { origin: "industry", version: "2.0.0", license: "proprietary" }),
        pack("freestyle", [tool("bare")]),
      ],
    });
    const namespaces = registry.udfFunctionSchemaNamespaces();
    expect(namespaces.find((ns) => ns.name === "risk")?.meta).toEqual({
      origin: "industry",
      version: "2.0.0",
      license: "proprietary",
    });
    expect(namespaces.find((ns) => ns.name === "freestyle")?.meta).toBeUndefined();
    expect(registry.getPackMeta("risk")?.origin).toBe("industry");
  });
});

describe("ADR-009 参考域 origin 标记", () => {
  test("loadReferenceInto 为参考域写入 origin=reference 元数据", () => {
    const registry = createUdfRuntime();
    loadReferenceInto(registry);
    const namespaces = registry.udfFunctionSchemaNamespaces();
    const crypto = namespaces.find((ns) => ns.name === "crypto");
    expect(crypto?.meta?.origin).toBe("reference");
    expect(typeof crypto?.meta?.version).toBe("string");
  });
});

describe("CONTRACT §6 端口注入接线（组合根）", () => {
  test("createUdfRuntime({ ports }) 经 setPorts 注入，getPorts() 可读（单进程语义）", async () => {
    const { getPorts } = await import("@republicroad/zen-udf");
    const egressGuard = {
      assertAllowed: (url: string) => {
        if (!url.startsWith("https://")) throw new Error(`egress denied: ${url}`);
      },
    };
    createUdfRuntime({ ports: { egressGuard } });
    expect(getPorts().egressGuard).toBe(egressGuard);
  });
});
