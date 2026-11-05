import { evaluateExpressionSync } from "@republicroad/zen-engine";

import type { ExpressionEvaluator } from "./fixtures.ts";

/** Node 世界便利工厂：zen-expression 对结果求值（ADR-014 OQ3 ① 定稿：context 平铺，裸键直引）。
 * 对象结果 → context 即结果本体（顶层键=变量，standard 语料重仓覆盖的已测面）；
 * 非对象结果（标量/数组/null）→ 绑定为 `result` 单键（`result == 42` 形态）。
 * 禁用 `$` 根与 `$.path` 导航——独立求值环境不绑定 `$`，路径 miss 恒 null 静默
 * （ADR-014 OQ3 修订增补，seal 二次修正裁定；1.4.0 起 `$.result.x` 旧约定废弃）。
 * 独立模块——fixtures.ts（runner 子路径 @republicroad/zen-udf/runner）保持零引擎
 * 依赖，表达式求值器只在根包面提供（ADR-014 包面注记）。 */
export const createZenExpressionEvaluator = (): ExpressionEvaluator => (source, data) =>
  evaluateExpressionSync(
    source,
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data },
  ) !== false;
