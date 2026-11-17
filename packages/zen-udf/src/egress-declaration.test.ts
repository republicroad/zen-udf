import { Type } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";

import { createUdfRuntime, tool, type UdfPackMeta, validatePack } from "./index.ts";
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
});
