import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecContext {
  /** 租户标识：多租户运行时强制要求（见 DecisionRuntime.evaluate 入口校验） */
  tenantId?: string;
  userId?: string;
  requestId?: string;
  /** 决策幂等键（Y2）：审计事件主键；act 类效果的幂等去重依据 */
  decisionId?: string;
  /** 事件时间（Y2，ISO 字符串）：审计 asOf 与 observe/query 类算子的事件时间锚点；缺省 = 处理时间 */
  eventTime?: string;
  /** 回放模式（Y3）：设置后 observe/act 类 UDF 不重执行，从 journal 读回当时返回值 */
  replay?: ReplayContext;
  /** 影子评估标记（AA1）：observe/query 照常执行；act 返回 intent 占位（不双次处置）。影子侧不产生审计事件 */
  shadow?: { prodRev: string };
  /** 请求内 observe memo 帧 id（批次 80 fact-once）：evaluateAsync 创建 opaque id，
   *  Map 本体挂 engine 模块级 registry——id 跨冻结副本/TSFN 克隆保真（journalId 同款），
   *  同请求内全部自定义节点（跨克隆）命中同一 memo Map；evaluateAsync finally 清理 */
  observeMemoId?: string;
  /**
   * 显式单租户豁免：置 true 后 evaluate 入口不再强制 tenantId，
   * 仅限 CLI / 本地 / 单租户部署使用；多租户服务端禁止开启。
   */
  tenantExempt?: boolean;
  /**
   * 审计 journal 通道（Y2 免 trace 化，内部）：本次执行的 journal 注册表 opaque id。
   * 随冻结副本跨 TSFN 传播，handleCustomNode 据其把 UDF 轨迹写入自记账 journal——
   * 副本只透传 id，journal 本体不可被图表达式触及（§5 篡改加固性质保持）。
   */
  journalId?: string;
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

/**
 * ExecContext 的跨原生边界通道键：zen-engine 的 customNode 回调经 Rust worker →
 * napi TSFN 派发回 JS 主线程，AsyncLocalStorage 不跨该边界存活（探针实证）。
 * DecisionRuntime.evaluate 把当前 ExecContext 以此保留键嵌入输入对象，
 * handleCustomNode 提取后用 runWithExecContext 重建立上下文，并对 passThrough
 * 输出剥离该键。仅对象形态输入支持（数组/原始值输入无法承载）。
 */
export const EXEC_CONTEXT_INPUT_KEY = "__zen_udf_exec_ctx__";
