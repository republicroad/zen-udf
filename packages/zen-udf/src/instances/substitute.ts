/** `$.dep` 引用的执行前替换（ADR-015 增补）——纯函数模块，自 engine.ts 迁出（零行为变化）。 */
import { asTypedValueEnvelope } from "./envelope.ts";

/**
 * 独立表达式绑定（evaluateExpressionSync）中 `$.key` 不是属性访问（恒 null——
 * 与引擎内联求值器语义不同），依赖实例的实参字符串里对**已完成前驱**的
 * `$.dep` 引用替换为裸键 `dep`——合并求值上下文（nodeInput ∪ 前驱输出）下
 * 裸键即取前驱输出。仅替换 resolved 集内的键、词边界精确（`$.a.v` → `a.v`
 * 的 `.v` 保持属性访问）。
 */
export function substituteInstanceRefs<T>(value: T, resolved: Set<string>): T {
  if (resolved.size === 0) return value;
  // 信封感知（ADR-016）：literal 信封整体跳过——其 value 是字面量非引用，
  // 替换即「静默变语义」复刻；expression 信封 value 内引用照常替换；
  // reference 信封 value 为路径形态无 $. 前缀，天然不受影响
  if (asTypedValueEnvelope(value)?.mode === "literal") return value;
  if (typeof value === "string") {
    let out: string = value;
    for (const dep of resolved) {
      out = out.replace(new RegExp(`\\$\\.${dep}(?![A-Za-z0-9_])`, "g"), dep);
    }
    return out as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteInstanceRefs(item, resolved)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteInstanceRefs(v, resolved);
    }
    return out as unknown as T;
  }
  return value;
}
