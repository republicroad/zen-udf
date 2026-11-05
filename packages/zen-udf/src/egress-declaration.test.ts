import { Type } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";

import { createUdfRuntime, egressHostMatches, tool, type UdfPackMeta, validatePack } from "./index.ts";
import { UdfRegistry } from "./register.ts";

describe("声明式出口清单（1.6.0，CONTRACT §6 可选面）", () => {
  describe("validatePack meta.egress 形状门", () => {
    const meta = (egress: unknown): { origin: "reference"; version: string; egress?: unknown } =>
      ({ origin: "reference", version: "1.0.0", egress }) as never;

    test("合法形态：精确域与通配域", () => {
      const pack = { namespace: "acme", meta: meta({ allow: ["api.example.com", "*.cdn.example.com"] }), tools: [] };
      expect(validatePack(pack as never).filter((e) => e.includes("egress"))).toEqual([]);
    });

    test("非法形态：缺 allow / 非数组 / 非 domain 字符串（scheme/路径/`*` 全通）", () => {
      expect(validatePack({ namespace: "acme", meta: meta({}), tools: [] } as never).join("\n")).toContain(
        "meta.egress must be an object with allow: string[]",
      );
      expect(
        validatePack({ namespace: "acme", meta: meta({ allow: "api.example.com" }), tools: [] } as never).join("\n"),
      ).toContain("meta.egress must be an object with allow: string[]");
      const bad = validatePack({
        namespace: "acme",
        meta: meta({ allow: ["https://api.example.com", "api.example.com/v1", "*", "*.com"] }),
        tools: [],
      } as never);
      expect(bad.filter((e) => e.includes("meta.egress.allow")).length).toBe(4);
    });
  });

  describe("egressHostMatches 匹配语义", () => {
    test("精确域：host 全等命中，子域不命中", () => {
      expect(egressHostMatches(["api.example.com"], "https://api.example.com/v1")).toBe(true);
      expect(egressHostMatches(["api.example.com"], "https://v1.api.example.com")).toBe(false);
      expect(egressHostMatches(["api.example.com"], "https://evil-api.example.com")).toBe(false);
    });

    test("通配域：命中子域与孙子域，不命中基域本体", () => {
      expect(egressHostMatches(["*.api.example.com"], "https://v1.api.example.com")).toBe(true);
      expect(egressHostMatches(["*.api.example.com"], "https://a.b.api.example.com")).toBe(true);
      expect(egressHostMatches(["*.api.example.com"], "https://api.example.com")).toBe(false);
    });

    test("大小写不敏感；非法 URL 一律不命中；空白名单不命中", () => {
      expect(egressHostMatches(["API.Example.COM"], "https://api.example.com")).toBe(true);
      expect(egressHostMatches(["api.example.com"], "not a url")).toBe(false);
      expect(egressHostMatches([], "https://api.example.com")).toBe(false);
    });
  });

  describe("registry.udfEgress 查询（交叉校验数据源）", () => {
    test("有声明 pack → 返回声明域；无声明 pack → undefined", () => {
      const registry = new UdfRegistry();
      const meta: UdfPackMeta = { origin: "extension", version: "2.0.0", egress: { allow: ["hooks.slack.com"] } };
      registry.register({
        id: "notify",
        meta,
        tools: [
          tool({
            namespace: "notify",
            name: "ping",
            description: "ping webhook",
            input: Type.Object({}),
            run: async () => ({ ok: true }),
          }),
        ],
      });
      expect(registry.udfEgress("ping")).toEqual(["hooks.slack.com"]);
      expect(registry.udfPackVersion("ping")).toBe("2.0.0");

      const bare = createUdfRuntime();
      expect(bare.udfEgress("nonexistent")).toBeUndefined();
    });
  });
});
