import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// debug 域：自定义节点开发态测试/断言工具。生产无作用。
// _node_input_ 为 customNode 执行规范的入参旁路通道——调试工具透传展示。
//
// ADR-011 迁移：理想态 tool()/pack()。开发态工具，semantics: query（纯读）。
import { Type } from "@sinclair/typebox";




export const inoutTool = tool({
  namespace: "debug",
  name: "inout",
  description: "Docstring for inout\n自定义函数测试, 返回值返回入参, 用于调试.",
  semantics: "query",
  input: Type.Object({
    b: Type.Integer({ description: "参数 b", title: "B" }),
    a: Type.Union([Type.String(), Type.Integer()], { description: "参数 a", title: "A" }),
    c: Type.Null({ description: "参数 c", title: "C" }),
  }),

  run: (input) => (input as unknown as Record<string, unknown>)?._node_input_ ?? {},
});

export const funcWithoutArgsTool = tool({
  namespace: "debug",
  name: "func_without_args",
  description: "Docstring for func_without_args\n无参数函数, 用于自定义函数测试",
  semantics: "query",
  input: Type.Object({}),

  run: (input) => (input as unknown as Record<string, unknown>)?._node_input_ ?? {},
});

export const tools = [inoutTool, funcWithoutArgsTool];

export default pack({ id: "debug", tools });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "debug", tools }));
