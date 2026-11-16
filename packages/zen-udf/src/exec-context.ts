import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 执行上下文（批次 167 立法：typed = 控制面，meta = 数据面）。
 *
 * zen-udf 是通用的 zen-engine 自定义节点上下文传递机制——应用域概念
 * （多租户命名空间隔离等）不占 typed 字段面，宿主业务经 meta 自维护。
 * 分区隔离键（缓存/熔断/并发闸/审计与指标事件）经 DecisionRuntime 的
 * partitionKey 提取器端口从宿主侧供给（引擎自身零应用域概念、不读 meta）。
 */
export interface ExecContext {
  // ── 控制面（引擎读，宿主构造）────────────────────────────────

  /** 行为开关（Y3 回放）：设置后 observe/act 类 UDF 不重执行，从 journal 读回当时返回值 */
  replay?: ReplayContext;
  /** 行为开关（AA1 影子评估）：observe/query 照常执行；act 返回 intent 占位（不双次处置）。影子侧不产生审计事件 */
  shadow?: { prodRev: string };
  /** 审计锚（Y2）：决策幂等键——审计事件主键；act 类效果的幂等去重依据 */
  decisionId?: string;
  /** 审计锚（Y2，ISO 字符串）：审计 asOf 与 observe/query 类算子的事件时间锚点；缺省 = 处理时间 */
  eventTime?: string;
  /**
   * 机制 id（@internal，引擎自产宿主仅透传——勿手工构造）：本次执行的 journal
   * 注册表 opaque id。随 TSFN 克隆传播，handleCustomNode 据其把 UDF 轨迹写入
   * 自记账 journal——副本只透传 id，journal 本体不可被图表达式触及。
   */
  journalId?: string;
  /**
   * 机制 id（@internal，引擎自产宿主仅透传——勿手工构造；批次 80 修订）：
   * **仅影子帧持有**（evaluateShadow 创建的 shadowMemoId，低频试跑场景）——
   * 生产热路径缺位即旁路。id 跨 TSFN 克隆保真，影子腿内跨节点命中同一 memo Map。
   */
  observeMemoId?: string;

  // ── 数据面（引擎永不读，宿主业务自维护）──────────────────────

  /**
   * 宿主元数据开放通道（OTel baggage 同款）：任意 JSON-able k/v，随 ALS/TSFN
   * 克隆传播。三契约：① 引擎语义【不读】此通道（data/control 分离——引擎行为
   * 只由 typed 字段与 partitionKey 提取器驱动，且提取器是宿主自己的函数）；
   * ② 值必须可结构化克隆（JSON-able：禁函数/类实例/symbol——TSFN serde 边界）；
   * ③ 体积建议上限 4KB（实现不强制）。
   * 消费方 = 工具/宿主经 getExecContext()?.meta；参考域约定键（contrib）：
   * `tenantId`/`userId`——多租户命名空间隔离等应用模式概念住这里。
   * 升格规则：某键被引擎语义依赖时 MUST 升格为 typed 字段（需 ADR）。
   */
  meta?: Record<string, unknown>;
}

/** 单条 UDF 观测 journal（来自审计事件 observed；Y3 回放的数据源） */
export interface ReplayJournalEntry {
  key: string;
  name: string;
  outcome: unknown;
  /** 回放钉扎（1.5.0）：审计时函数所属 pack 的 meta.version（observed.packVersion 透传）；缺省不参与钉扎 */
  packVersion?: string;
}

/** 回放上下文（Y3）：observe/act 不重执行（读 journal），query 用 asOf 时钟 */
export interface ReplayContext {
  decisionId: string;
  /** 事件时间（ISO）——query 类算子的事件时间锚点 */
  asOf: string;
  journal: ReplayJournalEntry[];
}

const execStorage = new AsyncLocalStorage<ExecContext>();

export const getExecContext = (): ExecContext | undefined => {
  return execStorage.getStore();
};

export const runWithExecContext = <T>(ctx: ExecContext, fn: () => Promise<T>): Promise<T> => {
  return execStorage.run(ctx, fn);
};

// 批次 166：保留键通道（EXEC_CONTEXT_INPUT_KEY，ExecContext 嵌入 input 的
// 跨 TSFN 载体）已退役——上下文改经 zen fork 原生 execution_context 通道
// （evaluate 第三参 → CustomNodeRequest.executionContext → handleCustomNode
// 重建 ALS）。执行上下文与 input 混流不利于规则治理与作用域隔离（宿主裁定）。
