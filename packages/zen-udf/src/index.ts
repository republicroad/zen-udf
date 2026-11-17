// zen-udf 核心运行时：引擎适配 / UdfPack 注册表 / L1 决策缓存 / ExecContext /
// 断路器 / 分区端口。
// 2.0.0 起**不再内置参考域**（batteries-included 拆除）——参考域（velocity/名单/
// http/号码/IP/identity 等 21 域）迁至 @republicroad/zen-udf-contrib，
// 经 loadReferenceInto(registry) 显式装载（实例隔离友好）。

export { type CircuitBreaker, InMemoryCircuitBreaker, NoopCircuitBreaker } from "./breaker.ts";
export {
  type CacheMetricsSnapshot,
  DecisionCache,
  type DecisionCacheEntry,
  type DecisionCacheOptions,
} from "./decision-cache.ts";
export {
  DecisionRuntime,
  type DecisionRuntimeOptions,
  type MetricsEvent,
  type UdfTrace,
} from "./engine.ts";
export {
  type ExecContext,
  getExecContext,
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
export {
  type ContribToolDef,
  type CreateUdfRuntimeOptions,
  type CustomFunctionTool,
  type CustomNodeNamespace,
  createUdfRuntime,
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
export type { ToolContext, ToolExample, UdfPackDef, UdfTool, UdfToolDef } from "./tool.ts";
export { type McpToolView, pack, toConformance, toMcpTool, tool } from "./tool.ts";
