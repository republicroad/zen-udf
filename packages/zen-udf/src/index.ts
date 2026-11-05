// zen-udf 核心运行时：引擎适配 / UdfPack 注册表 / L1 决策缓存 / ExecContext /
// 数据面端口 / 断路器 / Conformance 框架。
// 2.0.0 起**不再内置参考域**（batteries-included 拆除）——参考域（velocity/名单/
// http/号码/IP/identity 等 21 域）迁至 @republicroad/zen-udf-contrib，
// 经 loadReferenceInto(registry) 显式装载（实例隔离友好）。

export { type CircuitBreaker, InMemoryCircuitBreaker, NoopCircuitBreaker } from "./breaker.ts";
export { type EgressGuard, type SecretResolver } from "./ports.ts";
export {
  type GroupDistinctCommonResult,
  getRateStore,
  InMemoryRateStore,
  type RateCommonResult,
  type RateStore,
  setRateStore,
  __resetRateWindows,
} from "./rate-store.ts";
export {
  type CacheMetricsSnapshot,
  DecisionCache,
  type DecisionCacheEntry,
  type DecisionCacheOptions,
} from "./decision-cache.ts";
export {
  type DecisionAuditEvent,
  type DecisionObservedCall,
  DecisionRuntime,
  type DecisionRuntimeOptions,
  type MetricsEvent,
  type ShadowDiffEntry,
  type ShadowEvaluation,
  type UdfTrace,
} from "./engine.ts";
export {
  type ExecContext,
  getExecContext,
  type ReplayContext,
  type ReplayJournalEntry,
  runWithExecContext,
} from "./exec-context.ts";
export { createZenExpressionEvaluator } from "./expression-evaluator.ts";
export {
  type DecisionFixture,
  type DecisionTestExecutor,
  type Expectation,
  type ExpressionEvaluator,
  type FixtureOutcome,
  type FixtureReport,
  type FixtureResult,
  type RunDecisionTestsOptions,
  runDecisionTests,
} from "./fixtures.ts";
export { type ConcurrencyLimiter, InMemoryConcurrencyLimiter, NoopConcurrencyLimiter } from "./limiter.ts";
export type { UdfPorts } from "./ports.ts";
export { rateStoreConformance } from "./rate-store-conformance.ts";
export {
  type ContribToolDef,
  type CreateUdfRuntimeOptions,
  type CustomFunctionTool,
  type CustomNodeNamespace,
  createUdfRuntime,
  egressHostMatches,
  globalUdfRegistry,
  type JsonSchema,
  type JsonSchemaProperty,
  type PackQualityIssue,
  packChecks,
  packWarnings,
  RESERVED_NAMESPACE_PREFIXES,
  reservedNamespaceViolation,
  type UdfPack,
  type UdfPackMeta,
  UdfRegistry,
  type UdfSchema,
  type UdfSchemaParameter,
  type UdfSemantics,
  validatePack,
} from "./register.ts";
export { createRuntimeExecutor } from "./runtime-executor.ts";
export { getPorts, setPorts } from "./runtime-ports.ts";
export type { ToolContext, ToolExample, UdfPackDef, UdfTool, UdfToolDef } from "./tool.ts";
export { type McpToolView, pack, toConformance, toMcpTool, tool } from "./tool.ts";
