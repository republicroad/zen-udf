// trailing-window 参考域（trailing_count_1h / trailing_distinct_1h + rate_1h /
// group_distinct_1h 旧名 alias）。频控存储经 @republicroad/zen-udf 的 RateStore
// 端口（宿主 setRateStore 注入 Redis 化实现；缺省进程内参考实现）。
import { Type } from "@sinclair/typebox";

import { getExecContext, getRateStore, globalUdfRegistry } from "@republicroad/zen-udf";
import { pack, tool, type UdfTool } from "@republicroad/zen-udf";

const WINDOW_MS = 60 * 60 * 1000;

/** 事件时间锚点：ExecContext.eventTime / replay.asOf（ISO）→ epoch ms；缺省 undefined = 处理时间 */
const resolveAsOfMs = (): number | undefined => {
  const ctx = getExecContext();
  const iso = ctx?.eventTime ?? ctx?.replay?.asOf;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

// ADR-021 命名通式：trailing_<agg>_<window>（rolling 一词禁用——Flink/pandas 语境相反）；
// 语义声明：stateful=true（INCR 形态，重试双计——§1.3 禁自动重试）、temporal=event
// （asOf point-in-time 在参考实现原生支持）、fidelity=exact-per-event（逐事件精确）。
export const trailingCount1hTool = tool({
  namespace: "trailing-window",
  name: "trailing_count_1h",
  description: "频次统计：记录实体事件并返回其 1 小时 trailing 窗口内的事件计数。",
  semantics: "observe",
  temporal: "event",
  stateful: true,
  fidelity: "exact-per-event",
  input: Type.Object({
    entity: Type.String({ title: "实体", description: "计数实体（如 ip、phone）" }),
  }),
  output: Type.Object({
    counter: Type.Integer({ title: "Counter", default: 0 }),
    v: Type.String({ title: "V", default: "" }),
    idle: Type.Integer({ title: "Idle", default: 0 }),
    timestamp: Type.String({ title: "Timestamp", default: "" }),
  }),
  run: (input) => {
    const entity = String(input?.entity ?? "");
    return Promise.resolve(getRateStore().rate(entity, WINDOW_MS, resolveAsOfMs()));
  },
});

export const trailingDistinct1hTool = tool({
  namespace: "trailing-window",
  name: "trailing_distinct_1h",
  description: "组去重统计：记录 (组, 值) 事件并返回 1 小时 trailing 窗口内组事件数(pv)与去重值数(uv)。",
  semantics: "observe",
  temporal: "event",
  stateful: true,
  fidelity: "exact-per-event",
  input: Type.Object({
    group: Type.String({ title: "组", description: "分组键（如 ip）" }),
    value: Type.String({ title: "值", description: "组内观测值（如 phone）" }),
  }),
  output: Type.Object({
    idle: Type.Integer({ title: "Idle", default: 0 }),
    pv: Type.Integer({ title: "Pv", default: 0 }),
    uv: Type.Integer({ title: "Uv", default: 0 }),
    gidle: Type.Integer({ title: "Gidle", default: 0 }),
    vidle: Type.Integer({ title: "Vidle", default: 0 }),
    group: Type.String({ title: "Group", default: "" }),
    v: Type.String({ title: "V", default: "" }),
    timestamp: Type.String({ title: "Timestamp", default: "" }),
  }),
  run: (input) => {
    const group = String(input?.group ?? "");
    const value = String(input?.value ?? "");
    return Promise.resolve(getRateStore().groupDistinct(group, value, WINDOW_MS, resolveAsOfMs()));
  },
});

export const tools = [trailingCount1hTool, trailingDistinct1hTool];

/** 旧名 alias（ADR-021 §1.5 P4 方案 B 双名过渡）：同一 run 函数 + deprecated 元数据——存量图永久可读 */
const legacyAliases: UdfTool[] = [
  {
    ...trailingCount1hTool,
    namespace: "trailing-window",
    name: "rate_1h",
    deprecated: {
      since: "1.7.0",
      note: "ADR-021 改名 → trailing_count_1h（本名即同一函数的 alias）；过渡期后按 ADR-009 治理退役",
    },
  },
  {
    ...trailingDistinct1hTool,
    namespace: "trailing-window",
    name: "group_distinct_1h",
    deprecated: {
      since: "1.7.0",
      note: "ADR-021 改名 → trailing_distinct_1h（本名即同一函数的 alias）；过渡期后按 ADR-009 治理退役",
    },
  },
];

export default pack({ id: "trailing-window", tools: [...tools, ...legacyAliases] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）：新名 + 旧名 alias 双条目
globalUdfRegistry.register(pack({ id: "trailing-window", tools: [...tools, ...legacyAliases] }));

