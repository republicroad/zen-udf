import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// debugui 域(调试用专属 UI 函数，文件名即 namespace)
//
// ADR-011 迁移：理想态 tool()/pack()。
// 语义修正：current_date 依赖处理时间——semantics 由缺省 query 修正为 observe
// （回放改读 journal，不再重执行；对齐 Y3 语义三元定义）。
import { Type } from "@sinclair/typebox";




/** 服务器当前日期(本地时区，YYYY-MM-DD 格式)，无参数 */
export function currentDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const currentDateTool = tool({
  namespace: "debugui",
  name: "current_date",
  description: "返回服务器当前日期(本地时区，YYYY-MM-DD 格式)，无参数.",
  semantics: "observe",
  input: Type.Object({}),
  output: Type.String({ title: "current_date 函数返回" }),
  run: () => currentDate(),
});

export default pack({ id: "debugui", tools: [currentDateTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "debugui", tools: [currentDateTool] }));
