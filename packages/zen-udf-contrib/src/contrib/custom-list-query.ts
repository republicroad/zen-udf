import { getExecContext, globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

import { Type } from "@sinclair/typebox";




import { queryValueList } from "../value-list.ts";

/**
 * 旧平台函数域重建（第六十九批 D2，docs/13 §8.3）：名单查询复用 roster 存储的
 * queryValueList。调用形态对齐撞库攻击防御.json：`custom_list_query;;"名单名";;值`。
 * 返回图内 returnSchema 声明的 {result}（actor 隔离与 roster UDF 一致）。
 */
export const customListQueryTool = tool({
  namespace: "custom-list-query",
  name: "custom_list_query",
  title: "custom_list_query",
  description: "旧域重建·名单查询：在服务端指定名单中查询某个值是否存在，返回 {result}。",
  semantics: "query",
  input: Type.Object({
    list_name: Type.String({ title: "名单名称", description: "服务端名单名称" }),
    value: Type.String({ title: "查询值", description: "待查询的值" }),
  }),
  output: Type.Object({
    result: Type.Boolean({ title: "Result" }),
  }),
  run: (input) => {
    const ctx = getExecContext();
    if (!ctx?.tenantId) return { result: false };
    const { hit } = queryValueList(input.list_name, input.value ?? null, {
      tenantId: ctx.tenantId,
      actor: ctx.userId,
    });
    return { result: hit };
  },
});

export default pack({ id: "custom-list-query", tools: [customListQueryTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "custom-list-query", tools: [customListQueryTool] }));
