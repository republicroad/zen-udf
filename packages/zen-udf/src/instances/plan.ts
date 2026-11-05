/** 实例依赖调度（ADR-015 增补）——纯函数模块，自 engine.ts 迁出（零行为变化）。
 * DecisionRuntime 的同名静态方法保留为委托（公开 API 面不动）。 */
import { asTypedValueEnvelope } from "./envelope.ts";

export interface ExprAstItem {
  id: string;
  key: string;
  value: string | string[] | Record<string, unknown>;
  /** 实例依赖声明（ADR-015 增补，逃生门）：显式依赖的实例输出键（与 `$.key` 自动提取取并集） */
  dependsOn?: string[];
}

/**
 * `$.key` 根键提取（ADR-015 增补）：从字符串中取 `$.key` 访问器的根实例键
 * （嵌套访问 `$.a.b` 归根实例 a——F1 裁定）。仅字符串产生引用；对象/数组
 * 递归收集其字符串叶子（kwargs 实参值/位置实参）。
 */
export function extractInstanceRefs(value: unknown, into: Set<string>): void {
  // 信封感知（ADR-016）：literal 不含引用；expression 提取 $.refs；reference 取路径根段
  const env = asTypedValueEnvelope(value);
  if (env?.mode === "literal") return;
  if (env?.mode === "expression" && typeof env.value === "string") {
    const pattern = /\$\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null = pattern.exec(env.value);
    while (m !== null) {
      into.add(m[1]!);
      m = pattern.exec(env.value);
    }
    return;
  }
  if (typeof value === "string") {
    const pattern = /\$\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null = pattern.exec(value);
    while (m !== null) {
      into.add(m[1]!);
      m = pattern.exec(value);
    }
    return;
  }
  if (env?.mode === "reference" && typeof env.value === "string") {
    into.add(env.value.split(".")[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractInstanceRefs(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) extractInstanceRefs(item, into);
  }
}

/**
 * 实例依赖调度（ADR-015 增补：行内顺序求值进函数节点）——纯函数。
 *
 * 依赖边 = 自动提取（`$.key` 根引用，kwargs/位置实参的字符串叶子）∪
 * 显式 `dependsOn`（逃生门），**并集**（F2 裁定：显式是补充不是覆盖）；
 * 悬空引用（指向不存在的键）与自引用不建边（悬空属编辑面漂移带检出）。
 *
 * 返回分层调度表（层内并行、层间串行）或节点级结构化错误：
 * - DUPLICATE_OUTPUT：输出键重复 = 行内变量重声明（并行覆盖+遮蔽双风险）；
 * - CYCLE_DETECTED：依赖环（报错非死锁），列出环上实例键。
 * 零边 → 单层全并行（调用方借此走零开销快路径）。
 */
export function buildInstanceSchedule(
  items: ExprAstItem[],
):
  | { error: "DUPLICATE_OUTPUT"; keys: string[] }
  | { error: "CYCLE_DETECTED"; keys: string[] }
  | { layers: ExprAstItem[][]; hasEdges: boolean; depsByItem: Record<string, string[]> } {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) duplicates.add(item.key);
    seen.add(item.key);
  }
  if (duplicates.size > 0) {
    return { error: "DUPLICATE_OUTPUT", keys: [...duplicates] };
  }

  const byKey = new Map(items.map((item) => [item.key, item]));
  const deps = new Map<string, Set<string>>();
  let hasEdges = false;
  for (const item of items) {
    const refs = new Set<string>();
    const env = asTypedValueEnvelope(item.value);
    if (env?.mode === "reference" && typeof env.value === "string") {
      // reference 路径无 $. 前缀：根段即依赖实例键（tier.v → tier）
      refs.add(env.value.split(".")[0]);
    } else if (env?.mode === "expression") {
      extractInstanceRefs(env.value, refs);
    } else if (!env) {
      extractInstanceRefs(item.value, refs);
    }
    // literal 信封：value 为字面量不含引用（替换器亦跳过）
    for (const dep of item.dependsOn ?? []) refs.add(dep);
    // 自引用（dependsOn 自己 / 引用自己的输出键）不剔除——自依赖即环，
    // 归 CYCLE_DETECTED fail loud（实例无法先于自身产出，静默忽略会掩盖作者错误）
    const edges = new Set([...refs].filter((ref) => byKey.has(ref)));
    deps.set(item.key, edges);
    if (edges.size > 0) hasEdges = true;
  }

  // Kahn 分层：层内零入度并行，剥层推进；剩余未处理键即环上实例
  const layers: ExprAstItem[][] = [];
  const remaining = new Map(deps);
  const emitted = new Set<string>();
  while (remaining.size > 0) {
    const layer = [...remaining.entries()]
      .filter(([, edges]) => [...edges].every((dep) => emitted.has(dep)))
      .map(([key]) => byKey.get(key)!);
    if (layer.length === 0) {
      return { error: "CYCLE_DETECTED", keys: [...remaining.keys()] };
    }
    layers.push(layer);
    for (const item of layer) {
      emitted.add(item.key);
      remaining.delete(item.key);
    }
  }
  const depsByItem: Record<string, string[]> = {};
  for (const [key, edges] of deps) depsByItem[key] = [...edges];
  return { layers, hasEdges, depsByItem };
}
