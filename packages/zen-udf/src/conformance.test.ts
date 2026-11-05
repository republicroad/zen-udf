import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { UdfRegistry } from "./register.ts";

// CONTRACT.md §7 conformance 运行器：语言中立 fixtures 的 TS 侧消费者。
// 移植语言实现同一 fixtures 的等价运行器即可验收（契约即测试）。
// handlers：fixtures 是纯数据（无处理器）——call 动作的处理器由此处按
// `namespace.name` 供给（与实现解耦：换实现跑同一份 fixtures）。

const fixtures = JSON.parse(
  readFileSync(join((import.meta as { dir?: string }).dir ?? "src", "conformance", "fixtures.json"), "utf8"),
) as {
  contract: string;
  cases: Array<{
    kind: "tool" | "equivalence" | "registry" | "flat-removed";
    name?: string;
    tool?: Record<string, unknown>;
    handler?: string;
    actions?: Array<{ action: string; input?: unknown; args?: unknown[]; expect: Record<string, unknown> }>;
    flat?: { name: string; parameters: unknown };
    canonical?: { name: string; parametersSchema: unknown };
    positionalArgs?: unknown[];
    packs?: Array<{ id: string; meta?: unknown; tools: Array<Record<string, unknown>> }>;
    expect?: { registerErrorContains?: string };
  }>;
};

const HANDLERS: Record<string, (kwargs: Record<string, unknown>) => unknown> = {
  "credit.score": (kwargs) => {
    const base = Number(kwargs.base ?? 600);
    const income = Number(kwargs.income ?? 0);
    return { score: base + Math.min(Math.floor(income / 1000) * 5, 200) };
  },
  credit_score: (kwargs) => ({ score: (Number(kwargs.income ?? 0) / 1000) * 5 + Number(kwargs.base ?? 600) }),
};

/** 对象式 input → 位置参数数组（properties 键序，CONTRACT §5.1） */
const toPositional = (inputSchema: unknown, input: Record<string, unknown>): unknown[] => {
  const props = (inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(props).map((name) => input[name]);
};

const freshRegistry = (): UdfRegistry => new UdfRegistry();

describe(`CONTRACT conformance（fixtures v${fixtures.contract}）`, () => {
  for (const c of fixtures.cases) {
    if (c.kind === "tool") {
      describe(`tool ${c.tool!.namespace}.${c.tool!.name}`, () => {
        const registry = freshRegistry();
        const run = HANDLERS[`${c.tool!.namespace}.${c.tool!.name}`] ?? HANDLERS[c.handler!];
        registry.register({ id: c.tool!.namespace as string, tools: [{ ...c.tool!, run }] as never });
        const handler = HANDLERS[c.handler!];

        for (const action of c.actions ?? []) {
          if (action.action === "validate") {
            test(`validate(${JSON.stringify(action.input)}) → ${JSON.stringify(action.expect.errors)}`, () => {
              const positional = toPositional(c.tool!.inputSchema, action.input as Record<string, unknown>);
              const errors = registry.validatePositionalArgs(c.tool!.name as string, positional);
              if (action.expect.errorsContain) {
                expect(errors.some((e) => (e as string).includes(action.expect!.errorsContain as string))).toBe(true);
              }
              if (action.expect.errors) {
                expect(errors.length).toBe((action.expect.errors as unknown[]).length);
              }
            });
          }
          if (action.action === "bind") {
            test(`bind(${JSON.stringify(action.args)}) → ${JSON.stringify(action.expect.kwargs)}`, () => {
              expect(registry.funcBindParams(c.tool!.name as string, action.args as unknown[])).toEqual(
                action.expect.kwargs,
              );
            });
          }
          if (action.action === "call") {
            test(`call(${JSON.stringify(action.input)}) → ${JSON.stringify(action.expect.output)}`, async () => {
              const result = await registry.call(c.tool!.name as string, action.input as Record<string, unknown>);
              expect(result).toEqual(action.expect.output);
              void handler;
            });
          }
        }
      });
    }

    if (c.kind === "flat-removed") {
      // 1.0 行为锁（B 案终裁）：扁平 parameters 声明不再合成 parametersSchema——
      // 注册后无位置参数（positionalParams 空），位置绑定按 R1 报必填缺失
      describe(`1.0 行为锁：扁平声明已移除（${c.name}）`, () => {
        const flatReg = freshRegistry();
        flatReg.registerFunction((kwargs) => HANDLERS.credit_score(kwargs), "eq", c.flat as never, c.flat!.name);

        test("扁平声明不合成 parametersSchema：positionalParams 为空", () => {
          expect(flatReg.validatePositionalArgs(c.flat!.name, [])).toEqual([]);
          expect(flatReg.funcBindParams(c.flat!.name, [])).toEqual({});
        });

        test("位置绑定不抛错但无参数可绑（bind 返回空 kwargs——声明已移除）", () => {
          const schema = flatReg.udfFunctionSchema(c.flat!.name);
          expect(schema?.parametersSchema).toBeUndefined();
          expect(flatReg.funcBindParams(c.flat!.name, [600])).toEqual({});
        });
      });
    }

    if (c.kind === "registry") {
      describe(`registry 语义（${(c.packs ?? []).map((p) => p.id).join(" + ")}）`, () => {
        test(`注册失败含「${c.expect?.registerErrorContains}」`, () => {
          const registry = freshRegistry();
          let error: Error | null = null;
          try {
            for (const packDef of c.packs ?? []) {
              registry.register(packDef as never);
            }
          } catch (e) {
            error = e as Error;
          }
          expect(error).not.toBeNull();
          expect(error!.message).toContain(c.expect?.registerErrorContains ?? "");
        });
      });
    }
  }
});
