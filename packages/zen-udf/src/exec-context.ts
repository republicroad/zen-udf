import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 执行上下文（批次 170 立法：纯数据面）。
 *
 * zen-udf 是通用的 zen-engine 自定义节点上下文传递机制——效果同词法作用域 /
 * Python globals()/locals()：宿主在调用边界构造，节点内工具随处可读，图表达式
 * 不可见。ExecContext 只含开放数据面 meta——应用域概念（多租户身份、事件时间
 * 等）全部由宿主经约定键自维护，引擎自身零语义字段、零解读。
 *
 * 分区隔离键（缓存/熔断/并发闸/指标事件）经 DecisionRuntime 的 partitionKey
 * 提取器端口从宿主侧供给（读 meta 的是宿主自己的函数，data/control 分离保持）。
 *
 * 历史机制退役（4.0.0）：决策审计/确定性回放（Y2/Y3）/影子评估（AA1）随宿主
 * 裁定移除——宿主将重新设计规则回放（配专门的 UDF 日志文件）；未来按 additive
 * 回归（CONTRACT 升格规则，需 ADR）。
 */
export interface ExecContext {
  /**
   * 宿主元数据开放通道（OTel baggage 同款）：任意 JSON-able k/v，随 ALS/TSFN
   * 克隆传播。三契约：① 引擎语义【不读】此通道（分区隔离经 partitionKey 提取器
   * ——宿主自己的函数）；② 值必须可结构化克隆（JSON-able：禁函数/类实例/symbol
   * ——TSFN serde 边界）；③ 体积建议上限 4KB（实现不强制）。
   * 消费方 = 工具/宿主经 getExecContext()?.meta；约定键示例（宿主自定义，
   * 非引擎契约）：`tenantId`/`userId`/`requestId`（幂等键单源，ADR-021 §1.3）/
   * `eventTime`（事件时间锚，velocity/trailing 类算子消费；缺省 = 处理时间）。
   */
  meta?: Record<string, unknown>;
}

const execStorage = new AsyncLocalStorage<ExecContext>();

export const getExecContext = (): ExecContext | undefined => {
  return execStorage.getStore();
};

export const runWithExecContext = <T>(ctx: ExecContext, fn: () => Promise<T>): Promise<T> => {
  return execStorage.run(ctx, fn);
};
