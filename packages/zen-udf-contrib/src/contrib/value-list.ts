import { getExecContext, globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

import { Type } from "@sinclair/typebox";




import { queryValueList } from "../value-list.ts";

/**
 * value_list 工具面（原 roster 域，ADR verdict-009 D2 提案改名）：名单查询——
 * 在服务端租户名单中查询某值是否存在。双名过渡（trailing 改名同款）：
 * 新名 value_list/value_list（参数 list 直切——参数非注册名无 alias 机制，
 * verdict 零存量图直切零破坏）；旧名 roster/roster + 旧参数 roster 的适配
 * alias 同一查询核心 + deprecated 元数据，存量图永久可读。
 * v2 预留：value_list.record(list, value, ttl)（observe，velocity_record 镜像）
 * ——随宿主动态名单需求启动，本版不实现。
 */

const outputSchema = Type.Object(
  {
    hit: Type.Boolean({ title: "Hit", default: false }),
    list: Type.String({ title: "List", default: "" }),
    value: Type.Unknown({ title: "Value" }),
    version: Type.Optional(Type.Number({ title: "Version" })),
  },
  { title: "value_list 函数返回" },
);

const runQuery = (input: { list: string; value?: string }) => {
  const ctx = getExecContext();
  if (!ctx?.tenantId) return { hit: false, list: input.list, value: input.value ?? null };
  return queryValueList(input.list, input.value ?? null, {
    tenantId: ctx.tenantId,
    actor: ctx.userId,
  });
};

export const valueListTool = tool({
  namespace: "value_list",
  name: "value_list",
  title: "value_list",
  description: "查询名单：在服务端指定名单（value list）中查询某个值是否存在，返回命中结果。",
  semantics: "query",
  input: Type.Object({
    list: Type.String({ title: "名单", description: "服务端名单名称(从名单下拉中动态选择)" }),
    value: Type.String({ title: "查询值", description: "待查询的值" }),
  }),
  output: outputSchema,
  run: (input) => Promise.resolve(runQuery(input)),
});

/** 旧名 alias（roster → value_list 双名过渡）：同一查询核心 + 旧参数名 roster 适配 + deprecated 元数据 */
const aliasInput = Type.Object({
  roster: Type.String({ title: "名单", description: "服务端名单名称(从名单下拉中动态选择)" }),
  value: Type.String({ title: "查询值", description: "待查询的值" }),
});

export const rosterAliasTool = tool({
  namespace: "roster",
  name: "roster",
  title: "roster",
  description: valueListTool.description,
  semantics: "query",
  input: aliasInput,
  output: outputSchema,
  deprecated: {
    since: "1.8.0",
    note: "ADR verdict-009 D2 改名 → value_list（参数 roster→list）；本名即同一查询的 alias，过渡期（建议 2-3 个版本）后按 ADR-009 治理退役",
  },
  run: (input: { roster?: string; value?: string }) =>
    Promise.resolve(runQuery({ list: String(input?.roster ?? ""), value: input.value })),
});

export const tools = [valueListTool];

export default pack({ id: "value_list", tools: [...tools, rosterAliasTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）：新名 + 旧名 alias 双条目
globalUdfRegistry.register(pack({ id: "value_list", tools: [...tools, rosterAliasTool] }));
