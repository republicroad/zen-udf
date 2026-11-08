import type { Static, TSchema } from "@sinclair/typebox";

import type { ToolContext, UdfPackMeta, UdfSemantics } from "./register.ts";

/**
 * 理想态声明 API（CONTRACT.md §3/§4 的 TS 参考实现）：
 * tool() = 声明（schema-as-type + 语义治理 + examples conformance）；
 * pack() = 工具的显式集合（可 JSON 序列化的契约层，多语言交换形态）；
 * registry.register(entry) = 唯一注册入口。
 */

/** 执行上下文：宿主经端口注入，不进声明契约（CONTRACT §6） */
export type { ToolContext };

/** 时间档位（ADR-021 §1.1）：event=事件时间可锚（asOf 复算）；processing=处理时间（replay 路径受 §1.2 强制） */
export type UdfTemporal = "event" | "processing";
/** 保真披露（ADR-021 §1.1，R1 改名——与 velocity windowType 窗口语义轴正交）：聚合实现的保真度 */
export type UdfFidelity = "exact-per-event" | "bucketed" | "interpolated" | "sketch";

export interface ToolExample<I extends TSchema, O extends TSchema> {
  input: Static<I>;
  output: Static<O>;
}

export interface UdfToolDef<I extends TSchema, O extends TSchema> {
  /** ADR-009 namespace 立法：保留前缀（zen/core/reference/builtin）禁用 */
  namespace: string;
  name: string;
  title?: string;
  description: string;
  /** 语义三元（Y1）：query 纯读 / observe 观测累积 / act 处置效果（回放与影子据此分支） */
  semantics?: UdfSemantics;
  /** 时间档位（ADR-021 §1.1）：缺省 event；processing 在 replay 路径按宿主 ReplayPolicy 强制 */
  temporal?: UdfTemporal;
  /** 有状态声明（ADR-021 §1.3）：true = 禁自动重试（重试双计危害；幂等键 = ExecContext.requestId 单源贯穿） */
  stateful?: boolean;
  /** 保真披露（ADR-021 §1.1）：缺省 exact-per-event；进 trace 与目录（ε 口径依据） */
  fidelity?: UdfFidelity;
  /** act 必填：处置效果的重放安全声明（缺失 = 注册失败，CONTRACT §3.2） */
  idempotent?: boolean;
  /** 契约来源：TypeBox schema（既是运行时 JSON Schema 又是编译期类型） */
  input: I;
  /** 返回值契约（validateResult 档位校验） */
  output?: O;
  /** conformance 即声明：每个 example 生成 validate/bind/call 三断言（CONTRACT §3.5） */
  examples?: ToolExample<I, O>[];
  meta?: UdfPackMeta;
  deprecated?: { since?: string; note?: string };
  /** 处理器：签名 = input 静态类型；ctx 可选（执行策略经端口注入，处理器按需读取） */
  run: (input: Static<I>, ctx?: ToolContext) => Static<O> | Promise<Static<O>>;
}

export interface UdfTool<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  namespace: string;
  name: string;
  title?: string;
  description: string;
  semantics: UdfSemantics;
  temporal?: UdfTemporal;
  stateful?: boolean;
  fidelity?: UdfFidelity;
  idempotent?: boolean;
  /** 规范表示：纯 JSON Schema（TypeBox 构造经序列化剥除编译期标记） */
  inputSchema: object;
  outputSchema?: object;
  examples?: ToolExample<I, O>[];
  meta?: UdfPackMeta;
  deprecated?: { since?: string; note?: string };
  run(input: Static<I>, ctx?: ToolContext): Static<O> | Promise<Static<O>>;
}

/**
 * 声明一个工具。产物 = 规范表示 + 处理器引用：schema 经 JSON 序列化剥除
 * TypeBox 编译期 symbol 后即为纯 JSON Schema（契约层，多语言可读）。
 */
export const tool = <I extends TSchema, O extends TSchema>(def: UdfToolDef<I, O>): UdfTool<I, O> => ({
  ...def,
  semantics: def.semantics ?? "query",
  inputSchema: JSON.parse(JSON.stringify(def.input)) as object,
  ...(def.output ? { outputSchema: JSON.parse(JSON.stringify(def.output)) as object } : {}),
});

export interface UdfPackDef {
  /** pack id 即工具缺省 namespace（ADR-009：{pack-id}.{domain} 立法） */
  id: string;
  meta?: UdfPackMeta;
  // any：集合持有异构工具（各工具的 input/output 类型不同），类型安全由 tool() 声明位承担
  tools: UdfTool<any, any>[];
}

/** 声明一个 pack（可序列化契约层；注册经 registry.register） */
export const pack = (def: UdfPackDef): UdfPackDef => def;

/** 语言中立 conformance fixtures（CONTRACT §7）：从 pack 的 examples 导出，跨语言移植复用 */
export const toConformance = (def: UdfPackDef): object => ({
  contract: "1.0.0",
  cases: def.tools
    .filter((t) => t.examples && t.examples.length > 0)
    .map((t) => ({
      kind: "tool" as const,
      tool: {
        namespace: t.namespace,
        name: t.name,
        description: t.description,
        semantics: t.semantics,
        idempotent: t.idempotent,
        inputSchema: t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      },
      actions: (t.examples ?? []).flatMap((example) => [
        { action: "validate", input: example.input, expect: { errors: [] } },
        { action: "call", input: example.input, expect: { output: example.output } },
      ]),
    })),
});

/**
 * MCP Tool 视图派生（1.0 公开面）：semantics+idempotent 单一事实源派生 MCP
 * annotations（readOnlyHint/idempotentHint）——语义三元不外传确定性维度，
 * MCP 侧 annotations 仅为 UX hint（CONTRACT 哲学：宿主行为判定不依赖 hints）。
 * destructiveHint/openWorldHint 不可由三元推导，留宿主按工具性质自补。
 */
export interface McpToolView {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations: {
    readOnlyHint: boolean;
    idempotentHint?: boolean;
  };
}

export const toMcpTool = (t: UdfTool): McpToolView => ({
  name: t.namespace ? `${t.namespace}.${t.name}` : t.name,
  ...(t.title ? { title: t.title } : {}),
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: {
    readOnlyHint: t.semantics !== "act",
    ...(t.semantics === "act" && t.idempotent !== undefined ? { idempotentHint: t.idempotent } : {}),
  },
});
