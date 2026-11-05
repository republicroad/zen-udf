/** ADR-016 TypedValue 信封窄识别（单源）：engine 求值层与 register 校验层共用。
 * 独立叶子模块——engine.ts 与 register.ts 互相 import 成环，1.4.0 前以跨文件
 * 复制规避（双轨已实测漂移：register 侧未跟上 OQ2 的 literal 原始类型裁定），
 * 本模块消灭该双轨。 */

export type TypedValueEnvelope = { mode: "literal" | "expression" | "reference"; value: string | number | boolean };

/** 信封窄识别（ADR-016，单源）：恰为 mode+value 二键、mode 枚举、value 原始类型
 * （literal 允许 string/number/boolean——OQ2；expression/reference 要求字符串）。
 * object/array value = 非信封（按现状对象字面量透传，校验面按类型不符报）。 */
export function asTypedValueEnvelope(v: unknown): TypedValueEnvelope | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !("mode" in v) || !("value" in v)) return null;
  const mode = (v as { mode: unknown }).mode;
  const value = (v as { value: unknown }).value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  if (mode === "expression" || mode === "reference") {
    if (typeof value !== "string") return null;
  }
  if (mode !== "literal" && mode !== "expression" && mode !== "reference") return null;
  return { mode, value } as TypedValueEnvelope;
}
