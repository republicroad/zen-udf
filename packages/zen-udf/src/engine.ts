import { createHash } from "node:crypto";
import type {
  ZenDecision,
  ZenEngineHandlerRequest,
  ZenEngineHandlerResponse,
  ZenEngineOptions,
  ZenEvaluateOptions,
} from "@republicroad/zen-engine";
import { evaluateExpressionSync, ZenDecisionContent, ZenEngine } from "@republicroad/zen-engine";

import type { CircuitBreaker } from "./breaker.ts";
import { type CacheMetricsSnapshot, DecisionCache } from "./decision-cache.ts";
import { EXEC_CONTEXT_INPUT_KEY, type ExecContext, getExecContext, runWithExecContext } from "./exec-context.ts";
import { asTypedValueEnvelope, type TypedValueEnvelope } from "./instances/envelope.ts";
import { buildInstanceSchedule, type ExprAstItem, extractInstanceRefs } from "./instances/plan.ts";
import { substituteInstanceRefs } from "./instances/substitute.ts";
import type { ConcurrencyLimiter } from "./limiter.ts";
import { withOtelSpan } from "./otel.ts";
import type { JsonSchema } from "./register.ts";
import { globalUdfRegistry, type UdfRegistry, type UdfSemantics } from "./register.ts";
import { getPorts } from "./runtime-ports.ts";

const CUSTOM_HANDLER_META = "__meta__";

/** UDF 函数粒度执行轨迹（执行规范 §6.6）：经 customHandler 的 traceData 下发 */
export interface UdfTrace {
  /** 表达式实例 key（customNode 输出字段） */
  key: string;
  name: string;
  micros: number;
  /** 违例/异常码：INVALID_PARAM / UDF_TIMEOUT / INVALID_RESULT / UDF_NOT_FOUND / UDF_ERROR / REPLAYED / REPLAY_JOURNAL_MISS / CIRCUIT_OPEN */
  code?: string;
  issues?: string[];
  /** 算子语义（Y1） */
  semantics?: UdfSemantics;
  /** 回放钉扎（1.5.0）：调用时函数所属 pack 的 meta.version（注册期声明；未声明不记） */
  packVersion?: string;
  /** 保真披露（ADR-021 §1.1）：调用时函数声明的保真档（ε 口径的结果侧可见性） */
  fidelity?: string;
  /** UDF 返回值快照（Y2 审计 journal 依据；错误路径为结构化错误对象） */
  outcome?: unknown;
  /** act 语义幂等声明（Z1） */
  idempotent?: boolean;
}

/**
 * 审计 journal 注册表（Y2 免 trace 化）：evaluateAsync 为本次执行登记 accumulator，
 * handleCustomNode（全部 UDF 调用的必经分发点）经冻结副本携带的 journalId 写入。
 * 冻结副本只透传 opaque id——journal 本体不可被图表达式触及（§5 篡改加固性质保持）。
 * 审计/OTel 由此不再依赖上游 traceData，生产高频面无需强制开启引擎 trace。
 */
const auditJournalRegistry = new Map<string, UdfTrace[]>();

const newAuditJournalId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 字段级差异（AA1 影子评估 diff 报告） */
export interface ShadowDiffEntry {
  path: string;
  prod: unknown;
  shadow: unknown;
}

/** 影子评估结果：生产/影子双侧结论 + 等价性 + 字段级差异 */
export interface ShadowEvaluation {
  prod: unknown;
  shadow: unknown;
  equivalent: boolean;
  differences: ShadowDiffEntry[];
  prodPerformance?: string;
  shadowPerformance?: string;
}

/** 字段级深遍历 diff（对象递归；标量/数组/类型不一致记单条差异） */
const collectDiffs = (a: unknown, b: unknown, path: string, out: ShadowDiffEntry[]): ShadowDiffEntry[] => {
  if (a === b) return out;
  const bothObjects =
    a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (bothObjects) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      collectDiffs(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path ? path + "." + k : k,
        out,
      );
    }
    return out;
  }
  out.push({ path: path || "$", prod: a, shadow: b });
  return out;
};

interface EvaluateResponse {
  performance: string;
  result: unknown;
  trace?: unknown;
}

/** DecisionRuntime 构造项：zen-engine 原生 options + 实例级 UDF 注册表 + L1 缓存配置 */
export interface DecisionRuntimeOptions extends Omit<ZenEngineOptions, "customHandler"> {
  /** 缺省回落 globalUdfRegistry（配合 `@republicroad/zen-udf` 根导入的 reference 装载） */
  registry?: UdfRegistry;
  /**
   * L7/ADR-008：宿主自定义分发 handler。返回 undefined（not-handled 语义）时回落
   * 内置 UDF 分发（decline）；或显式委托 runtime.handleCustomNode（组合形态）。
   * 缺省 = 全部走内置 UDF 分发。详见 ADR-008。
   */
  customHandler?: (request: ZenEngineHandlerRequest) => Promise<ZenEngineHandlerResponse | undefined>;
  /** L1 决策缓存容量（条目数），缺省 500 */
  cacheCapacity?: number;
  /** 缓存指标 sink（verdict 接 Prometheus 用），每次读写后回调快照 */
  metricsSink?: (snapshot: CacheMetricsSnapshot) => void;
  /** 空闲 TTL 毫秒（BB3）：条目自 lastAccess 超过该时长即惰性过期；缺省关闭 */
  idleTtlMs?: number;
  /** per-tenant 并发闸（执行规范 §6.3）；缺省不限并发 */
  limiter?: ConcurrencyLimiter;
  /** 熔断器（Y5）：per tenantId+udfName 故障隔离；缺省无熔断 */
  breaker?: CircuitBreaker;
  /**
   * 返回值契约档位（执行规范 §6.5，宿主裁决 D5）：缺省 `warn`——违例计入 traceData、
   * 结果原样下发；`enforce` 把违例结果替换为 INVALID_RESULT 结构化错误。
   */
  resultValidation?: "off" | "warn" | "enforce";
  /** UDF 错误消息脱敏器（执行规范 §6.7）；缺省内置规则（路径/敏感环境值替换为占位） */
  sanitizer?: (message: string) => string;
  /** 决策审计事件 sink（Y2）：evaluate 完成后回调；持久化属宿主。配置后 evaluate 内部强制开启 trace */
  onDecision?: (event: DecisionAuditEvent) => void;
  /** OpenTelemetry 桥（Y6）：置 true 且宿主安装 @opentelemetry/api 时，evaluate 产生根 span（UdfTrace 作为事件） */
  otel?: boolean;
  /** 统一观测 sink（BB5）：UDF/熔断/并发闸事件流；缺省 undefined = 不出观测事件 */
  metrics?: (event: MetricsEvent) => void;
}

/** 单个 UDF 的观测记录（Y2 审计事件 observed 数组项） */
/**
 * 统一观测事件（BB5）：metrics sink 按 kind 聚合——
 * udf（每次 UDF 调用）/ circuit（熔断拒绝）/ limiter（并发闸等待）。
 * verdict 侧聚合成 Prometheus 指标（如 zen_udf_udf_errors_total）。
 */
export type MetricsEvent =
  | { kind: "udf"; name: string; tenantId?: string; micros: number; code?: string; idempotent?: boolean }
  | { kind: "circuit"; key: string; allowed: false }
  | { kind: "limiter"; key: string; waitMicros: number };

export interface DecisionObservedCall {
  key: string;
  name: string;
  semantics: UdfSemantics;
  /** 返回值快照（含结构化错误对象——journal 回放依据；act 语义 MUST NOT 携带入参载荷，CONTRACT §5） */
  outcome: unknown;
  micros: number;
  /** act 语义幂等声明（Z1，verdict 审计可见） */
  idempotent?: boolean;
  /** 回放钉扎（1.5.0）：调用时函数所属 pack 的 meta.version——pack 升级后回放漂移的可检出来源 */
  packVersion?: string;
  /** 保真披露（ADR-021 §1.1）：审计侧 ε 口径可见性 */
  fidelity?: string;
  /** 审计哈希链（1.0：Trust Chain 验证记录完整性）：sha256(前链哈希+本条稳定序列化)，链种子=inputHash */
  hash?: string;
}

/**
 * 决策审计事件（Y2）：决策完成时经 onDecision 下发，持久化属宿主。
 * inputHash = sha256(JSON.stringify(input))——数据最小化；原文存储属宿主策略。
 * observed 含 query/observe/act 全部 UDF 返回值快照，是 Y3 回放 journal 的来源。
 */
export interface DecisionAuditEvent {
  decisionId: string;
  tenantId: string;
  key: string;
  rev: string;
  inputHash: string;
  /** 完整决策结论（宿主裁决 D11） */
  output: unknown;
  /** 事件时间（ExecContext.eventTime；缺省 = 处理时间） */
  asOf?: string;
  processingTime: string;
  requestId?: string;
  source: "live" | "replay";
  observed: DecisionObservedCall[];
  performance?: string;
  /** journal 格式版本（1.0 契约；宿主按此 upcast 历史留存记录） */
  journalVersion: number;
  /** 哈希链终值（1.0：逐条 hash 链 + inputHash 种子）——Trust Chain 验证记录完整性 */
  journalDigest?: string;
}

interface GraphNode {
  type?: string;
  name?: string;
  content?: {
    config?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface GraphContent {
  id?: string;
  metadata?: Record<string, unknown>;
  nodes: GraphNode[];
  [key: string]: unknown;
}

function evaluateExpressionSafe(expr: string, input?: unknown): unknown {
  try {
    return evaluateExpressionSync(expr, input);
  } catch {
    return null;
  }
}

/** 内置脱敏规则（执行规范 §6.7）：绝对路径占位 + 敏感名环境变量值替换为 [ENV_NAME] */
/** AA3 输入序列化守卫：非有限数值（NaN/Infinity）无法跨 Rust 边界，执行前 fail fast */
const assertJsonSafeInput = (input: unknown): void => {
  JSON.stringify(input, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("[zen-udf] input contains a non-finite number (NaN/Infinity)");
    }
    return value;
  });
};

const sanitizeErrorDefault = (message: string): string => {
  let out = message.replace(/(?:[A-Za-z]:)?(?:[/\\][^\s'"`]+)+/g, "[path]");
  for (const [name, value] of Object.entries(process.env)) {
    if (/(secret|token|password|key|credential)/i.test(name) && value && value.length >= 4) {
      out = out.split(value).join(`[${name.toUpperCase()}]`);
    }
  }
  return out;
};

class DecisionRuntime {
  static CUSTOM_HANDLER_META = CUSTOM_HANDLER_META;

  engine: ZenEngine;
  options: DecisionRuntimeOptions;
  /** 实例级 UDF 注册表（缺省回落 globalUdfRegistry；多实例互不污染） */
  registry: UdfRegistry;
  /** L1 决策缓存（键含租户与 rev，见 docs/design/zen-udf-multi-tenant.md §3） */
  cache: DecisionCache;
  /** per-tenant 并发闸（缺省 undefined = 不限并发） */
  limiter?: ConcurrencyLimiter;
  /** 熔断器（缺省 undefined = 不熔断） */
  breaker?: CircuitBreaker;
  /** 返回值契约档位（缺省 warn，宿主裁决 D5） */
  resultValidation: "off" | "warn" | "enforce";
  /** 错误消息脱敏器 */
  sanitizer: (message: string) => string;
  /** 决策审计事件 sink（缺省 undefined = 不出审计事件） */
  onDecision?: (event: DecisionAuditEvent) => void;
  /** OTel 桥开关（缺省 false） */
  otel: boolean;
  /** 统一观测 sink（缺省 undefined = 不出观测事件） */
  metrics?: (event: MetricsEvent) => void;

  constructor(options: DecisionRuntimeOptions = {}) {
    this.registry = options.registry ?? globalUdfRegistry;
    this.cache = new DecisionCache({
      capacity: options.cacheCapacity,
      metricsSink: options.metricsSink,
      idleTtlMs: options.idleTtlMs,
    });
    this.limiter = options.limiter;
    this.breaker = options.breaker;
    this.resultValidation = options.resultValidation ?? "warn";
    this.sanitizer = options.sanitizer ?? sanitizeErrorDefault;
    this.onDecision = options.onDecision;
    this.otel = options.otel ?? false;
    this.metrics = options.metrics;
    // L7（ADR-008）：宿主 customHandler 与内置 UDF 分发可组合——宿主 handler
    // 返回 undefined（not-handled 语义）时回落内置分发器（decline 语义）；
    // 内置分发器同时以 runtime.handleCustomNode 公开（显式委托形态，二选一或组合均可）。
    let installedHandler: NonNullable<ZenEngineOptions["customHandler"]>;
    if (options.customHandler != null) {
      const hostHandler = options.customHandler;
      installedHandler = async (request) => {
        const handled = await hostHandler(request);
        if (handled === undefined) {
          return this.handleCustomNode(request);
        }
        return handled;
      };
    } else {
      installedHandler = (request) => this.handleCustomNode(request);
    }
    // engine 视角的 handler 永不返回 undefined（decline 已回落内置），类型随之收窄
    const engineOptions: ZenEngineOptions = { ...options, customHandler: installedHandler };
    this.options = engineOptions;
    this.engine = new ZenEngine(engineOptions);
  }

  createDecision(content: string | object): ZenDecision {
    const contentObj = typeof content === "string" ? JSON.parse(content) : content;
    const enhanced = this.graphAddons(contentObj);
    const decisionContent = new ZenDecisionContent(enhanced);
    return this.engine.createDecision(decisionContent);
  }

  /**
   * L1 缓存键：`${tenantId}:${key}@${rev}`——不可变版本键，与 verdict `modelId:v{rev}` 对齐。
   * tenantExempt 时租户段为 'single'；无任何租户上下文时拒绝（fail closed）。
   */
  private composeCacheKey(key: string, rev?: string): string {
    const ctx = getExecContext();
    const tenant = ctx?.tenantId ?? (ctx?.tenantExempt ? "single" : "");
    if (!tenant) {
      throw new Error("[zen-udf] cache operations require exec context tenantId (or tenantExempt)");
    }
    return tenant + ":" + key + "@" + (rev ?? "latest");
  }

  private buildAndCache(cacheKey: string, content: string | object): ZenDecision {
    const startedAt = this.cache.markBuildStart();
    const decision = this.createDecision(content);
    this.cache.markBuildEnd(startedAt);
    this.cache.set(cacheKey, { decision, content });
    return decision;
  }

  createDecisionWithCacheKey(key: string, content: string | object, rev?: string): ZenDecision {
    const cacheKey = this.composeCacheKey(key, rev);
    if (this.cache.has(cacheKey)) {
      throw new Error(
        "rule key:" + key + " is existed, if confirm to overwrite this key, please use updateDecisionWithCacheKey",
      );
    }
    return this.buildAndCache(cacheKey, content);
  }

  updateDecisionWithCacheKey(key: string, content: string | object, rev?: string): ZenDecision {
    const cacheKey = this.composeCacheKey(key, rev);
    if (!this.cache.has(cacheKey)) {
      throw new Error("rule key:" + key + " is not existed, please use createDecisionWithCacheKey");
    }
    return this.buildAndCache(cacheKey, content);
  }

  deleteDecisionWithCacheKey(key: string, rev?: string): void {
    const cacheKey = this.composeCacheKey(key, rev);
    if (!this.cache.has(cacheKey)) {
      throw new Error("delete failed! rule key:" + key + " is not existed");
    }
    this.cache.delete(cacheKey);
  }

  getDecision(key: string, rev?: string): ZenDecision {
    const cacheKey = this.composeCacheKey(key, rev);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached.decision;
    }
    const loader = this.options.loader;
    // zen-engine 2.0：loader 为「函数 | static/fs/zip 对象」四形联合——本仓仅支持同步函数形态
    if (typeof loader !== "function") {
      throw new Error("decision " + key + " not found, please use createDecisionWithCacheKey");
    }
    const decisionContent = loader(key);
    if (decisionContent instanceof Promise) {
      throw new Error("loader returned a Promise; only sync loaders are supported for now");
    }
    const startedAt = this.cache.markBuildStart();
    const decision = this.createDecision(decisionContent);
    this.cache.markBuildEnd(startedAt);
    this.cache.set(cacheKey, { decision, content: decisionContent });
    return decision;
  }

  getDecisionCache(key: string, rev?: string): ZenDecision | undefined {
    return this.cache.get(this.composeCacheKey(key, rev))?.decision;
  }

  getContentCache(key: string, rev?: string): unknown {
    return this.cache.get(this.composeCacheKey(key, rev))?.content;
  }

  /**
   * 多租户安全默认（fail closed）：evaluate 入口强制租户上下文。
   * 单租户 CLI/本地场景在 ExecContext 设 tenantExempt: true 显式豁免。
   */
  private static requireTenantContext(): void {
    const ctx = getExecContext();
    if (ctx?.tenantExempt) return;
    if (!ctx?.tenantId) {
      throw new Error(
        "[zen-udf] missing exec context tenantId — wrap the call in runWithExecContext({ tenantId }, fn), or set tenantExempt: true for single-tenant deployments",
      );
    }
  }

  /**
   * ALS 不跨 zen-engine 的 Rust worker → TSFN 回调边界存活（探针实证），
   * 把当前 ExecContext 以保留键嵌入输入对象，由 handleCustomNode 提取后
   * 重建立上下文。仅对象输入可承载；其余形态按无上下文执行（UDF 内 fail closed）。
   * 嵌入的是冻结副本：防图表达式篡改调用方持有的共享 ctx 对象（加固 §5）。
   */
  private static enrichInputWithExecContext(ctx: unknown): unknown {
    if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) {
      return ctx;
    }
    const execCtx = getExecContext();
    if (!execCtx) {
      return ctx;
    }
    return { ...(ctx as Record<string, unknown>), [EXEC_CONTEXT_INPUT_KEY]: Object.freeze({ ...execCtx }) };
  }

  /**
   * observed 收集（Y2 免 trace 化）：分发器自记账 journal 优先，节点 traceData 作
   * 并集兜底——宿主 customHandler 自带 traceData 的节点只出现在后者。去重键
   * key+name+micros（同一调用在两来源中为同值；跨 wasm 边界为克隆故按值去重）。
   */
  private collectObservedTraces(journal: UdfTrace[] | undefined, result: EvaluateResponse): UdfTrace[] {
    const merged: UdfTrace[] = [];
    const seen = new Set<string>();
    const add = (t: UdfTrace): void => {
      const dedupe = `${t.key}::${t.name}::${t.micros}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      merged.push(t);
    };
    for (const t of journal ?? []) add(t);
    const trace = result.trace as
      | Record<string, { traceData?: { udf?: Array<UdfTrace & { outcome?: unknown; semantics?: UdfSemantics }> } }>
      | undefined;
    for (const nodeTrace of Object.values(trace ?? {})) {
      for (const t of nodeTrace?.traceData?.udf ?? []) add(t);
    }
    return merged;
  }

  /**
   * 审计事件（Y2）：observed 来源=分发器自记账 journal 并集节点 traceData
   * （journal 通道不可用时回退强制 trace，见 evaluateAsync）。配置后 evaluate
   * 内部不再强制开启引擎 trace——生产高频面审计成本从全量 traceData 降到
   * 仅 UDF 快照。sink 异常不中断决策（仅 console.error）。
   */
  private emitAudit(
    execCtx: ExecContext | undefined,
    key: string,
    rev: string | undefined,
    rawInput: unknown,
    result: EvaluateResponse,
    journal?: UdfTrace[],
  ): void {
    if (!this.onDecision) return;
    try {
      const inputHash = createHash("sha256").update(JSON.stringify(rawInput)).digest("hex");
      // 审计哈希链（1.0）：种子 = inputHash，逐条 sha256(前链哈希 + 稳定序列化)——
      // 宿主/Trust Chain 重算链条即可验证记录未被篡改（验证计算 + 验证记录完整性）
      const observed: DecisionObservedCall[] = [];
      let chain = inputHash;
      for (const t of this.collectObservedTraces(journal, result)) {
        const entry: DecisionObservedCall = {
          key: t.key,
          name: t.name,
          semantics: t.semantics ?? "query",
          idempotent: t.idempotent,
          outcome: t.outcome,
          micros: t.micros,
          packVersion: this.registry.udfPackVersion(t.name),
        };
        entry.hash = createHash("sha256")
          .update(
            chain +
              JSON.stringify({
                key: entry.key,
                name: entry.name,
                semantics: entry.semantics,
                outcome: entry.outcome,
                micros: entry.micros,
                packVersion: entry.packVersion,
              }),
          )
          .digest("hex");
        chain = entry.hash;
        observed.push(entry);
      }
      const event: DecisionAuditEvent = {
        decisionId: execCtx?.decisionId ?? globalThis.crypto?.randomUUID?.() ?? `dec-${Date.now()}-${Math.random()}`,
        tenantId: execCtx?.tenantId ?? "single",
        key,
        rev: rev ?? "latest",
        inputHash,
        output: result.result,
        asOf: execCtx?.eventTime,
        processingTime: new Date().toISOString(),
        requestId: execCtx?.requestId,
        source: execCtx?.replay ? "replay" : "live",
        observed,
        performance: result.performance,
        journalVersion: 1,
        journalDigest: chain === inputHash ? undefined : chain,
      };
      this.onDecision(event);
    } catch (sinkError) {
      console.error(
        "[zen-udf] onDecision sink failed:",
        sinkError instanceof Error ? sinkError.message : String(sinkError),
      );
    }
  }

  evaluate(key: string, ctx: unknown, options?: unknown, rev?: string): Promise<EvaluateResponse> {
    return this.evaluateAsync(key, ctx, options, rev);
  }

  async evaluateAsync(key: string, ctx: unknown, options?: unknown, rev?: string): Promise<EvaluateResponse> {
    const evalInternal = async (
      span?: { addEvent(name: string, attrs: Record<string, unknown>): void } | undefined,
    ) => {
      DecisionRuntime.requireTenantContext();
      assertJsonSafeInput(ctx);
      const decision = this.getDecision(key, rev);
      const execCtx = getExecContext();
      // Y2 审计免 trace 化：有执行上下文时 observed 经分发器自记账（handleCustomNode
      // 是全部 UDF 调用的必经点；journal 经 journalId 注册表跨冻结副本传递），不再
      // 强制上游 trace。上下文缺位的遗留调用面（CLI/豁免直调）journal 通道不可用，
      // 保留旧行为：强制 trace + traceData 收集。
      const needsAuditSink = this.onDecision != null || this.otel;
      const journalId = needsAuditSink && execCtx ? newAuditJournalId() : undefined;
      const journal = journalId ? ([] as UdfTrace[]) : undefined;
      if (journalId && journal) auditJournalRegistry.set(journalId, journal);
      const evalOpts =
        needsAuditSink && !journal
          ? ({ ...(options as Record<string, unknown> | undefined), trace: true } as ZenEvaluateOptions)
          : (options as ZenEvaluateOptions | null | undefined);
      try {
        const evaluateCall = async () =>
          decision.evaluate(DecisionRuntime.enrichInputWithExecContext(ctx), evalOpts) as Promise<EvaluateResponse>;
        const result: EvaluateResponse = journalId
          ? await runWithExecContext({ ...(execCtx as ExecContext), journalId }, evaluateCall)
          : await evaluateCall();
        // 剥离输出中的上下文保留键（AA1：键仅用于跨 TSFN 传播，不进最终结论）
        if (result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)) {
          delete (result.result as Record<string, unknown>)[EXEC_CONTEXT_INPUT_KEY];
        }
        this.emitAudit(execCtx, key, rev, ctx, result, journal);
        // Y6：UdfTrace 作为 span events（与审计同一并集来源，不再依赖强制 trace）
        if (span) {
          for (const t of this.collectObservedTraces(journal, result)) {
            span.addEvent("zen-udf.udf", { key: t.key, name: t.name, micros: t.micros, code: t.code ?? "ok" });
          }
        }
        return result;
      } finally {
        if (journalId) auditJournalRegistry.delete(journalId);
      }
    };
    if (this.otel) {
      return withOtelSpan(
        "zen-udf.evaluate",
        { attributes: { "zen-udf.key": key, "zen-udf.rev": rev ?? "latest" } },
        (span) => evalInternal(span),
      );
    }
    return evalInternal();
  }

  /**
   * 批量评估（AA4）：同模型多输入并发执行，逐条错误隔离（单条失败不影响他条）。
   * 每条独立走 evaluateAsync（租户上下文/审计/缓存语义与单请求完全一致）。
   */
  async evaluateMany(
    key: string,
    jobs: Array<{ input: unknown; options?: unknown; rev?: string }>,
  ): Promise<Array<{ ok: true; result: EvaluateResponse } | { ok: false; error: string }>> {
    return Promise.all(
      jobs.map(async (job) => {
        try {
          return { ok: true as const, result: await this.evaluateAsync(key, job.input, job.options, job.rev) };
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }

  /**
   * 影子评估（AA1）：生产 rev 正常执行（含审计），影子 rev 并行重演——
   * act 类影子侧不执行（intent 占位，不双次处置，宿主裁决 D15 推荐）；影子侧不产生审计事件（off-path）。
   * 用于模型发布前的灰度对比：不一致率达标后切流。
   */
  async evaluateShadow(
    key: string,
    revs: { prod: string; shadow: string },
    input: unknown,
    options?: ZenEvaluateOptions,
  ): Promise<ShadowEvaluation> {
    DecisionRuntime.requireTenantContext();
    const base = getExecContext();
    const prod = await this.evaluateAsync(key, input, options, revs.prod);

    const shadowExec = {
      ...(base ?? { tenantExempt: true }),
      tenantId: base?.tenantId ?? "single",
      shadow: { prodRev: revs.prod },
    };
    const shadowDecision = this.getDecision(key, revs.shadow);
    const enrichedShadowInput = {
      ...((input ?? {}) as Record<string, unknown>),
      [EXEC_CONTEXT_INPUT_KEY]: Object.freeze({ ...shadowExec }),
    };
    const shadowResult = (await runWithExecContext(shadowExec as ExecContext, () =>
      shadowDecision.evaluate(enrichedShadowInput, options as ZenEvaluateOptions | null | undefined),
    )) as EvaluateResponse;
    // 最终结论剥离上下文保留键
    if (
      shadowResult.result !== null &&
      typeof shadowResult.result === "object" &&
      !Array.isArray(shadowResult.result)
    ) {
      delete (shadowResult.result as Record<string, unknown>)[EXEC_CONTEXT_INPUT_KEY];
    }

    const differences: ShadowDiffEntry[] = [];
    collectDiffs(prod.result, shadowResult.result, "", differences);
    return {
      prod: prod.result,
      shadow: shadowResult.result,
      equivalent: differences.length === 0,
      differences,
      prodPerformance: prod.performance,
      shadowPerformance: shadowResult.performance,
    };
  }

  /**
   * 确定性回放（Y3）：从审计事件构造 replay 上下文重演决策。
   * - observe/act：不重执行，读 journal 中钉住的当时返回值
   * - query：以 asOf 为时钟正常执行
   * - 输入校验：sha256(input) 必须匹配审计 inputHash，否则抛错（trust 语义）
   * 回放本身也会产生一条 source: 'replay' 的审计事件。
   */
  async evaluateReplay(
    audit: DecisionAuditEvent,
    input: unknown,
    options?: ZenEvaluateOptions,
  ): Promise<EvaluateResponse> {
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (inputHash !== audit.inputHash) {
      throw new Error(
        `[zen-udf] replay input hash mismatch — supplied input (\`${inputHash.slice(0, 12)}\`) does not match the audited decision (\`${audit.inputHash.slice(0, 12)}\`)`,
      );
    }
    const execCtx: ExecContext = {
      tenantId: audit.tenantId,
      requestId: audit.requestId,
      decisionId: audit.decisionId,
      eventTime: audit.asOf,
      replay: {
        decisionId: audit.decisionId,
        asOf: audit.asOf ?? audit.processingTime,
        journal: audit.observed.map((o) => ({ key: o.key, name: o.name, outcome: o.outcome })),
      },
    };
    return runWithExecContext(execCtx, () =>
      this.evaluateAsync(audit.key, input, options, audit.rev === "latest" ? undefined : audit.rev),
    );
  }

  graphAddons(content: GraphContent): object {
    const ruleGraph = JSON.parse(JSON.stringify(content)) as GraphContent;

    if (!ruleGraph.id) {
      ruleGraph.id =
        typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `decision-${Date.now()}`;
    }

    const inputNodeName =
      ruleGraph.nodes
        .filter((n) => n.type === "inputNode")
        .map((n) => n.name)
        .filter(Boolean)[0] ?? "";

    const ruleId = ruleGraph.id ?? "";
    const ruleMeta = ruleGraph.metadata ?? {};
    (ruleMeta as Record<string, unknown>)["namespace"] = ruleId;
    (ruleMeta as Record<string, unknown>)["inputNode_name"] = inputNodeName;

    for (const node of ruleGraph.nodes) {
      if (node.type !== "customNode") continue;
      const config = (node.content?.config ?? {}) as Record<string, unknown>;

      const chMeta = ((config[CUSTOM_HANDLER_META] as Record<string, unknown>) ??
        (config["meta"] as Record<string, unknown>) ??
        {}) as Record<string, unknown>;
      Object.assign(chMeta, ruleMeta);
      config[CUSTOM_HANDLER_META] = chMeta;

      if (config["passThrough"] == null) {
        config["passThrough"] = true;
      }

      const customExpressions = config["expressions"] as ExprAstItem[] | undefined;
      if (customExpressions) {
        const exprAsts: ExprAstItem[] = [];
        for (const funcItem of customExpressions) {
          const item = { ...funcItem };
          item.value = DecisionRuntime.normalizeOperatorCall(funcItem.value);
          exprAsts.push(item);
        }
        config["expr_asts"] = exprAsts;
      }
    }

    return ruleGraph;
  }

  static parseOperatorExpr(expr: string | string[]): string[] {
    if (Array.isArray(expr)) {
      return expr;
    }
    const pattern = /;;(?=(?:[^"'`]*["'`][^"'`]*["'`])*[^"'`]*$)/;
    const parts = expr.split(pattern).map((s) => s.trim());
    return parts;
  }

  /**
   * 调用形态归一（JSON-RPC 式类型判别）：字符串 = legacy `;;`、数组 = 位置、
   * 对象 = 命名（`$call` 保留键 + 具名实参）。对象形态原样透传，执行期判别。
   */
  static normalizeOperatorCall(
    value: string | string[] | Record<string, unknown>,
  ): string | string[] | Record<string, unknown> {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return DecisionRuntime.parseOperatorExpr(value as string | string[]);
  }

  /**
   * 规范化调用为 ADR-015 具名字典形态（CONTRACT §11 canonical）：
   * `{ $call: fn, kwargs: {...} }`。
   *
   * 三形态同吃（与执行语义同源——经 normalizeOperatorCall）：
   * - 具名对象：已规范（kwargs 信封）或 legacy 平面（除 $call 外键即参数），照实收编；
   * - 位置数组：按 parametersSchema.properties 键序映射为具名；
   *   **结构归一、值不造**——超出声明位的多余位置值原样收进保留键
   *   `$positional`（$ 前缀与参数键永不碰撞，供漂移带按 extra 检出）；
   * - 表达式字符串：经 parseOperatorExpr 同路径解析（与执行一致的单一事实源）；
   *   不可解析返回 null。
   *
   * 编辑面用途：保存时归一（ADR-015 §2.3）+ 漂移带按名检测的输入侧。
   */
  static normalizeNamedCall(
    value: unknown,
    parametersSchema?: JsonSchema | null,
  ): { $call: string; kwargs: Record<string, unknown> } | null {
    if (value === null || value === undefined) return null;
    let normalized: string | string[] | Record<string, unknown>;
    try {
      normalized = DecisionRuntime.normalizeOperatorCall(value as string | string[] | Record<string, unknown>);
    } catch {
      return null; // 不可解析（与执行侧 parserError 同源）
    }
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      const callSpec = normalized as Record<string, unknown>;
      const fn = String(callSpec["$call"] ?? "");
      if (!fn) return null;
      const envelope = callSpec["kwargs"];
      if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
        return { $call: fn, kwargs: { ...(envelope as Record<string, unknown>) } };
      }
      const kwargs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(callSpec)) {
        if (k !== "$call") kwargs[k] = v;
      }
      return { $call: fn, kwargs };
    }
    if (!Array.isArray(normalized)) return null;
    const fn = String(normalized[0] ?? "");
    if (!fn) return null;
    const positional = normalized.slice(1);
    const props =
      parametersSchema && typeof parametersSchema === "object"
        ? ((parametersSchema as { properties?: Record<string, unknown> }).properties ?? {})
        : {};
    const keys = Object.keys(props);
    const kwargs: Record<string, unknown> = {};
    positional.forEach((v, i) => {
      if (i < keys.length) kwargs[keys[i]!] = v;
    });
    // 未映射的位置值（超声明位或无 schema 可依）原样收进保留键——值不造、键不造
    if (positional.length > keys.length) {
      kwargs.$positional = positional.slice(Math.max(keys.length, 0));
    } else if (keys.length === 0 && positional.length > 0) {
      kwargs.$positional = positional;
    }
    return { $call: fn, kwargs };
  }

  /**
   * 平面 kwargs 歧义检测（ADR-015 双读的唯一行为变化点，编辑面漂移带消费）：
   * 调用对象带 `kwargs: Record` 键时引擎**必按信封解释**（CONTRACT §11）——
   * 若函数同时声明了字面 `kwargs` 参数，作者的平面传参意图即无法表达
   * （0.13 前可成功绑定，0.14 起变 INVALID_PARAM）。检出即提示迁移规范形：
   * `{$call, kwargs: { kwargs: {...} }}`。无 schema 可依时返回 false
   * （无声明参数即无歧义，信封是唯一读法）。
   */
  static detectKwargsEnvelopeAmbiguity(value: unknown, parametersSchema?: JsonSchema | null): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const callSpec = value as Record<string, unknown>;
    if (!callSpec["$call"]) return false;
    const envelope = callSpec["kwargs"];
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return false;
    const props =
      parametersSchema && typeof parametersSchema === "object"
        ? ((parametersSchema as { properties?: Record<string, unknown> }).properties ?? {})
        : {};
    return "kwargs" in props;
  }

  /**
   * `$.key` 根键提取（ADR-015 增补）——实现住 instances/plan.ts（1.5.0 整理重构：
   * 纯模块移动，静态方法保留为公开 API 委托）。
   */
  static extractInstanceRefs(value: unknown, into: Set<string>): void {
    extractInstanceRefs(value, into);
  }

  /**
   * 实例依赖调度（ADR-015 增补：行内顺序求值进函数节点）——实现住 instances/plan.ts
   * （1.5.0 整理重构：纯模块移动，静态方法保留为公开 API 委托）。
   *
   * 依赖边 = 自动提取（`$.key` 根引用）∪ 显式 `dependsOn`（并集，F2 裁定）；
   * 返回分层调度表或节点级结构化错误（DUPLICATE_OUTPUT / CYCLE_DETECTED）；
   * 零边 → 单层全并行（调用方借此走零开销快路径）。
   */
  static buildInstanceSchedule(
    items: ExprAstItem[],
  ):
    | { error: "DUPLICATE_OUTPUT"; keys: string[] }
    | { error: "CYCLE_DETECTED"; keys: string[] }
    | { layers: ExprAstItem[][]; hasEdges: boolean; depsByItem: Record<string, string[]> } {
    return buildInstanceSchedule(items);
  }

  /** 信封窄识别（ADR-016 单源）——实现住 instances/envelope.ts（1.5.0 整理重构：
   * engine 求值层与 register 校验层共用的叶子模块，双轨副本已消灭）。 */
  static asTypedValueEnvelope(v: unknown): TypedValueEnvelope | null {
    return asTypedValueEnvelope(v);
  }

  /**
   * `$.dep` 引用的执行前替换（ADR-015 增补）——实现住 instances/substitute.ts
   * （1.5.0 整理重构：纯模块移动，静态方法保留为公开 API 委托）。
   */
  static substituteInstanceRefs<T>(value: T, resolved: Set<string>): T {
    return substituteInstanceRefs(value, resolved);
  }

  /**
   * 内置 customNode 分发器（L7/ADR-008）：经 this.registry 解析 UDF 工具，实例绑定
   * （多运行时互不串扰）。
   *
   * 公开形态（L7 二选一之一）：宿主 customHandler 可显式委托——
   *   customHandler: async (request) => {
   *     if (isMyProtocolNode(request)) return myDispatch(request);
   *     return runtime.handleCustomNode(request);
   *   }
   * 或对未处理节点返回 undefined 走 decline 回落（构造器自动包装）。
   */
  async handleCustomNode(request: ZenEngineHandlerRequest): Promise<ZenEngineHandlerResponse> {
    const node = request.node;
    const exprAsts = (node.config?.["expr_asts"] ?? []) as ExprAstItem[];
    const inputField = (node.config?.["inputField"] as string | null) ?? null;
    const outputPath = (node.config?.["outputPath"] as string | null) ?? null;
    const passThrough = (node.config?.["passThrough"] as boolean | null) ?? null;
    const meta = (node.config?.[CUSTOM_HANDLER_META] as Record<string, unknown>) ?? {};

    // ExecContext 重建立：ALS 不跨 TSFN 边界，从嵌入输入的保留键恢复（见 evaluate）
    const rawInput = (request.input ?? {}) as Record<string, unknown>;
    const execCtx = rawInput[EXEC_CONTEXT_INPUT_KEY] as ExecContext | undefined;

    const context: Record<string, unknown> = {
      node_id: node.id,
      [CUSTOM_HANDLER_META]: meta,
      passThrough,
      inputField,
      outputPath,
    };

    const execute = async (): Promise<ZenEngineHandlerResponse> => {
      // 执行规范 §6.6：UDF 函数粒度轨迹（经 traceData 下发，simulator/verdict 审计共用）
      const traces: UdfTrace[] = [];

      // ADR-015 增补：实例依赖调度——默认并行维持 + 声明依赖才串行
      // （DAG：$.key 自动提取 ∪ dependsOn 逃生门，悬空引用不建边归编辑面漂移带；
      // 输出键重声明与依赖环 = 执行前结构化错误；零边单层 = 原 Promise.all 等价）
      const schedule = DecisionRuntime.buildInstanceSchedule(exprAsts);
      if ("error" in schedule) {
        const issues =
          schedule.error === "CYCLE_DETECTED"
            ? [`dependency cycle among output keys: ${schedule.keys.join(", ")}`]
            : [`duplicate output keys: ${schedule.keys.join(", ")}`];
        return { output: { error: { code: schedule.error, issues } } };
      }

      const results: Record<string, unknown> = {};
      const completedOutputs: Record<string, unknown> = {};
      const failedKeys = new Set<string>();

      for (const [layerIndex, layer] of schedule.layers.entries()) {
        // 依赖实例的求值上下文 = nodeInput ∪ 已完成前驱输出（输出遮蔽同名输入，
        // 对齐表达式节点行内求值语义）；_node_input_ 保持纯 nodeInput
        const evalContext =
          layerIndex === 0 || completedOutputs.size === 0
            ? undefined
            : {
                ...(typeof request.input === "object" && request.input !== null ? request.input : {}),
                ...completedOutputs,
              };
        const settled = await Promise.all(
          layer.map(async (item) => {
            // 失败传播：前驱实例执行错误 → 依赖实例不执行，收 INVALID_DEPENDENCY
            // （级联：传播失败也计入 failedKeys）；失败判定 = 本实例新增轨迹带结构化错误码
            const deps = schedule.depsByItem[item.key] ?? [];
            const failedDeps = deps.filter((d) => failedKeys.has(d));
            if (failedDeps.length > 0) {
              const badOutcome = {
                error: { code: "INVALID_DEPENDENCY", issues: [`dependency failed: ${failedDeps.join(", ")}`] },
              };
              traces.push({
                key: item.key,
                name: "(dependency)",
                micros: 0,
                code: "INVALID_DEPENDENCY",
                outcome: badOutcome,
              });
              failedKeys.add(item.key);
              return { item, outcome: badOutcome as unknown };
            }
            const before = traces.length;
            const resolved = new Set(deps.filter((d) => !failedKeys.has(d)));
            const execItem =
              resolved.size > 0 && evalContext ? DecisionRuntime.substituteInstanceRefs(item, resolved) : item;
            const outcome = await this.executeExpr(execItem, request.input, context, traces, evalContext);
            const failed = traces.slice(before).some((t) => t.key === item.key && typeof t.code === "string");
            if (failed) failedKeys.add(item.key);
            return { item, outcome };
          }),
        );
        for (const { item, outcome } of settled) {
          results[item.key] = outcome;
          completedOutputs[item.key] = outcome;
        }
      }

      // Y2 免 trace 化：同一份轨迹自记账进本次执行的审计 journal（journalId 注册表；
      // traceData 仍随 handler 响应交给引擎透传——调试面不受影响）
      const auditJournal = execCtx?.journalId ? auditJournalRegistry.get(execCtx.journalId) : undefined;
      if (auditJournal) auditJournal.push(...traces);

      if (passThrough && typeof request.input === "object" && request.input !== null) {
        const input = request.input as Record<string, unknown>;
        for (const key of Object.keys(input)) {
          if (key !== "$nodes") {
            // EXEC_CONTEXT_INPUT_KEY 随 passThrough 向下传播（下游 act 节点依赖），
            // 最终结论在 evaluateAsync 出口统一剥离
            results[key] = input[key];
          }
        }
      }

      if (outputPath) {
        const tmp = evaluateExpressionSafe(`${outputPath}=_`, { _: results }) as Record<string, unknown> | undefined;
        if (tmp && typeof tmp === "object") {
          Object.assign(results, tmp);
        }
      }

      if (traces.length > 0) {
        for (const t of traces) {
          this.metrics?.({
            kind: "udf",
            name: t.name,
            tenantId: execCtx?.tenantId,
            micros: t.micros,
            code: t.code,
            idempotent: t.idempotent,
          });
        }
      }
      return traces.length > 0 ? { output: results, traceData: { udf: traces } } : { output: results };
    };

    return execCtx ? runWithExecContext(execCtx, execute) : execute();
  }

  private async executeExpr(
    execExpr: ExprAstItem,
    nodeInput: unknown,
    context: Record<string, unknown>,
    traces: UdfTrace[],
    evalContext?: unknown,
  ): Promise<unknown> {
    let breakerKey: string | null = null;
    try {
      const exprId = execExpr.id;
      const exprAst = execExpr.value;

      // 调用形态判别：对象 = 命名（$call 保留键 + 具名实参，值可为 zen 表达式串或字面量）；
      // 字符串/数组 = 位置（`;;` legacy / 数组默认）
      const isNamedCall = exprAst !== null && typeof exprAst === "object" && !Array.isArray(exprAst);
      let funcName: string;
      let opArgExpressions: string[] = [];
      let namedArgs: Record<string, unknown> | null = null;
      if (isNamedCall) {
        const callSpec = exprAst as Record<string, unknown>;
        funcName = String(callSpec["$call"] ?? "");
        if (!funcName) {
          const badOutcome = { error: { code: "INVALID_PARAM", issues: ['named call requires a string "$call" key'] } };
          traces.push({
            key: execExpr.key,
            name: "(unnamed)",
            micros: 0,
            code: "INVALID_PARAM",
            semantics: "query" as UdfSemantics,
            outcome: badOutcome,
          });
          return badOutcome;
        }
        namedArgs = {};
        // ADR-015 调用规范双读：{$call, kwargs} 嵌套信封（canonical）优先；
        // legacy 平面形态（除 $call 外键即参数）长期兼容。kwargs 键为普通
        // Record 时按信封解释——参数恰好名为 kwargs 的平面调用属歧义形态，
        // 信封胜出（迁移规范形即消除歧义，CONTRACT §11）
        const envelope = callSpec["kwargs"];
        if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
          namedArgs = { ...(envelope as Record<string, unknown>) };
        } else {
          for (const [k, v] of Object.entries(callSpec)) {
            if (k !== "$call") namedArgs[k] = v;
          }
        }
      } else {
        const ast = Array.isArray(exprAst) ? exprAst : DecisionRuntime.parseOperatorExpr(exprAst as string);
        funcName = ast[0] as string;
        opArgExpressions = ast.slice(1);
      }

      const inputField = context["inputField"] as string | null;
      const fSchema = this.registry.udfFunctionSchema(funcName);
      const semantics = (fSchema?.semantics as UdfSemantics | undefined) ?? "query";
      const temporal = (fSchema?.temporal as "event" | "processing" | undefined) ?? "event";
      const fidelity = fSchema?.fidelity as "exact-per-event" | "bucketed" | "interpolated" | undefined;
      const stateful = fSchema?.stateful as boolean | undefined;
      const idempotent = fSchema?.idempotent as boolean | undefined;

      // AA1 影子评估：act 类影子侧不执行（返回 intent 占位，绝不双次处置）；observe/query 照常
      const shadowMark = getExecContext()?.shadow;
      if (shadowMark && semantics === "act") {
        const intentOutcome = { intent: true, skipped: "shadow", name: funcName };
        traces.push({ key: execExpr.key, name: funcName, micros: 0, semantics, outcome: intentOutcome });
        return intentOutcome;
      }

      // Y3 回放模式：observe/act 不重执行——从 ExecContext.replay.journal 读回当时返回值；
      // journal 缺失 fail closed（REPLAY_JOURNAL_MISS），query 类正常执行（时钟用 asOf）
      const replayCtx = getExecContext()?.replay;
      if (replayCtx && semantics !== "query") {
        const entry = replayCtx.journal.find((j) => j.key === execExpr.key && j.name === funcName);
        if (!entry) {
          const missOutcome = {
            error: { code: "REPLAY_JOURNAL_MISS", issues: [`no journaled outcome for ${funcName}`] },
          };
          traces.push({
            key: execExpr.key,
            name: funcName,
            micros: 0,
            code: "REPLAY_JOURNAL_MISS",
            semantics,
            outcome: missOutcome,
          });
          return missOutcome;
        }
        traces.push({
          key: execExpr.key,
          name: funcName,
          micros: 0,
          code: "REPLAYED",
          semantics,
          idempotent,
          outcome: entry.outcome,
        });
        // 回放钉扎（1.5.0）：journal 记录的 pack 版本 ≠ 当前注册表 = 函数已升级，
        // 回放确定性前提被破坏——fail visible（与 REPLAY_JOURNAL_MISS 同款逐条结构化错误；
        // 旧审计无 packVersion 不参与钉扎，存量回放行为不变）
        const currentPin = this.registry.udfPackVersion(funcName);
        if (entry.packVersion && currentPin && entry.packVersion !== currentPin) {
          const pinOutcome = {
            error: {
              code: "REPLAY_PIN_MISMATCH",
              issues: [
                `function ${funcName} was ${entry.packVersion} at audit time, registry now has ${currentPin} — replay determinism requires the audited pack`,
              ],
            },
          };
          traces.push({
            key: execExpr.key,
            name: funcName,
            micros: 0,
            code: "REPLAY_PIN_MISMATCH",
            semantics,
            outcome: pinOutcome,
          });
          return pinOutcome;
        }
        return entry.outcome;
      }

      // ADR-021 §1.2 replay 强制：processing 时间档工具在 replay 路径按宿主
      // ReplayPolicy 执行（observe/act 走 journal 读回不重执行无此险；query 重执行受检。
      // 与 1.5.0 回放钉扎同通道——journal/observed 携 packVersion，本处携时间档位强制）。
      // strict=RATE_NO_EVENT_TIME fail visible；degraded=处理时间回退 + TEMPORAL_FALLBACK 标注。
      if (replayCtx && temporal === "processing") {
        if ((getPorts()?.replayPolicy ?? "degraded") === "strict") {
          const noEventTimeOutcome = {
            error: {
              code: "RATE_NO_EVENT_TIME",
              message: `tool ${funcName} declares temporal: 'processing' and cannot serve replay.asOf — supply an event-time implementation or set ports.replayPolicy (ADR-021 §1.2)`,
            },
          };
          traces.push({
            key: execExpr.key,
            name: funcName,
            micros: 0,
            code: "RATE_NO_EVENT_TIME",
            semantics,
            outcome: noEventTimeOutcome,
          });
          return noEventTimeOutcome;
        }
        traces.push({
          key: execExpr.key,
          name: funcName,
          micros: 0,
          code: "TEMPORAL_FALLBACK",
          semantics,
          outcome: { temporalFallback: true, name: funcName },
        });
      }
      if (fSchema) {
        let operatorKwargs: Record<string, unknown>;
        if (namedArgs) {
          // 命名形态：字符串值 = zen 表达式（按 inputField 前缀求值），非字符串 = 字面量；
          // ADR-016 信封（{mode, value} 窄识别）= 模式显式化——literal 原样绑定
          // （绕过 inputField 拼接与求值），expression 求值，reference 按 $.value 路径求值
          const evaluated: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(namedArgs)) {
            const env = DecisionRuntime.asTypedValueEnvelope(v);
            if (env) {
              // literal：原样绑定（绕过 inputField 拼接与求值）；
              // expression/reference 首期同义（OQ1）：与裸字符串同路径求值（inputField 前缀），
              // reference 的路径形态在替换后上下文下等价——schema 校验位预留不实现
              if (env.mode === "literal") {
                evaluated[k] = env.value;
              } else {
                const expr = inputField ? `${inputField}.${env.value as string}` : String(env.value);
                evaluated[k] = evaluateExpressionSafe(expr, evalContext ?? nodeInput);
              }
            } else {
              evaluated[k] =
                typeof v === "string"
                  ? evaluateExpressionSafe(inputField ? `${inputField}.${v}` : v, evalContext ?? nodeInput)
                  : v;
            }
          }
          const bind = this.registry.bindNamedArgs(funcName, evaluated);
          if (bind.issues.length > 0) {
            const invalidParamOutcome = { error: { code: "INVALID_PARAM", issues: bind.issues } };
            traces.push({
              key: execExpr.key,
              name: funcName,
              micros: 0,
              code: "INVALID_PARAM",
              semantics,
              outcome: invalidParamOutcome,
            });
            return invalidParamOutcome;
          }
          operatorKwargs = bind.kwargs;
        } else {
          // $positional 元素信封（ADR-016，OQ5 同批）：literal 原样绑定不走 inputField 拼接
          const args = opArgExpressions.map((raw: string | Record<string, unknown>) => {
            const env = DecisionRuntime.asTypedValueEnvelope(raw);
            if (env?.mode === "literal") return env.value;
            const i = env ? String(env.value) : (raw as string);
            const expr = inputField ? `${inputField}.${i}` : i;
            return evaluateExpressionSafe(expr, evalContext ?? nodeInput);
          });

          // 执行规范 §6.1：位置参数必填项前置校验
          const paramIssues = this.registry.validatePositionalArgs(funcName, args);
          if (paramIssues.length > 0) {
            const invalidParamOutcome = { error: { code: "INVALID_PARAM", issues: paramIssues } };
            traces.push({
              key: execExpr.key,
              name: funcName,
              micros: 0,
              code: "INVALID_PARAM",
              issues: paramIssues,
              semantics,
              outcome: invalidParamOutcome,
            });
            return invalidParamOutcome;
          }

          operatorKwargs = this.registry.funcBindParams(funcName, args);
        }
        const kwargs: Record<string, unknown> = {
          ...operatorKwargs,
          ...context,
          func_id: exprId,
          expr_id: exprId,
          _node_input_: nodeInput,
        };

        // 执行规范 §6.3：per-tenant 并发闸（注入 limiter 时生效）
        const tenantId = getExecContext()?.tenantId;
        // Y5：熔断检查（per tenantId+udfName），打开时 CIRCUIT_OPEN 快速失败
        breakerKey = tenantId ? `${tenantId}:${funcName}` : funcName;
        if (this.breaker && !this.breaker.allow(breakerKey)) {
          const openOutcome = { error: { code: "CIRCUIT_OPEN", message: `circuit open for ${breakerKey}` } };
          this.metrics?.({ kind: "circuit", key: breakerKey, allowed: false });
          traces.push({
            key: execExpr.key,
            name: funcName,
            micros: 0,
            code: "CIRCUIT_OPEN",
            semantics,
            outcome: openOutcome,
          });
          return openOutcome;
        }
        let release: (() => void) | null = null;
        if (this.limiter && tenantId) {
          const waitStart = process.hrtime.bigint();
          release = await this.limiter.acquire(tenantId);
          this.metrics?.({
            kind: "limiter",
            key: tenantId,
            waitMicros: Number(process.hrtime.bigint() - waitStart) / 1000,
          });
        }
        let result: unknown;
        const startedAt = process.hrtime.bigint();
        // 执行规范 §6.2：kwargs.timeout 约定（毫秒）——运行时级超时兜底，超时返回结构化错误；
        // 同时经 ToolContext.signal 向 fn 传播取消（重 I/O 函数应把 signal 传给底层客户端）
        const timeoutMs = typeof kwargs.timeout === "number" && kwargs.timeout > 0 ? kwargs.timeout : null;
        const execCtx = getExecContext();
        const callController = new AbortController();
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const call = this.registry.call(funcName, kwargs, {
            name: funcName,
            tenantId: execCtx?.tenantId,
            userId: execCtx?.userId,
            requestId: execCtx?.requestId,
            signal: callController.signal,
            deadlineAt: timeoutMs ? Date.now() + timeoutMs : null,
            // ADR-021：宿主 HTTP/重试包装器据此执行 §1.3 禁重试纪律（幂等键 = requestId 单源贯穿）
            temporal,
            stateful,
            fidelity,
          });
          result = timeoutMs
            ? await Promise.race([
                call,
                new Promise((_resolve, reject) => {
                  timeoutTimer = setTimeout(() => {
                    callController.abort();
                    reject(new Error("udf timeout after " + timeoutMs + "ms"));
                  }, timeoutMs);
                }),
              ])
            : await call;
          this.breaker?.recordSuccess(breakerKey);
        } catch (timeoutError) {
          this.breaker?.recordFailure(breakerKey);
          const message = timeoutError instanceof Error ? timeoutError.message : String(timeoutError);
          if (message.includes("udf timeout")) {
            const timeoutOutcome = { error: { code: "UDF_TIMEOUT", message } };
            traces.push({
              key: execExpr.key,
              name: funcName,
              micros: 0,
              code: "UDF_TIMEOUT",
              semantics,
              outcome: timeoutOutcome,
            });
            return timeoutOutcome;
          }
          throw timeoutError;
        } finally {
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
          }
          release?.();
        }
        const micros = Number(process.hrtime.bigint() - startedAt) / 1000;

        // 执行规范 §6.5：返回值契约（缺省 warn——只记账不改行为；enforce 换成结构化错误）
        if (this.resultValidation !== "off") {
          const resultIssues = this.registry.validateResult(funcName, result);
          if (resultIssues.length > 0) {
            traces.push({
              key: execExpr.key,
              name: funcName,
              micros,
              code: "INVALID_RESULT",
              issues: resultIssues,
              semantics,
              outcome: result,
            });
            if (this.resultValidation === "enforce") {
              return { error: { code: "INVALID_RESULT", issues: resultIssues } };
            }
          }
        }

        traces.push({ key: execExpr.key, name: funcName, micros, semantics, idempotent, fidelity, outcome: result });
        return result;
      } else {
        if (funcName) {
          const notFoundOutcome = { error: `udf ${funcName} not found` };
          traces.push({
            key: execExpr.key,
            name: funcName,
            micros: 0,
            code: "UDF_NOT_FOUND",
            semantics,
            outcome: notFoundOutcome,
          });
          return notFoundOutcome;
        }
        const emptyOutcome = { error: "empty udf name not allowed" };
        traces.push({ key: execExpr.key, name: "", micros: 0, code: "UDF_NOT_FOUND", outcome: emptyOutcome });
        return emptyOutcome;
      }
    } catch (error) {
      // UDF 抛错不下发为 null(否则 simulator 无痕吞错)：以结构化错误对象出现在 trace/输出中
      if (breakerKey) this.breaker?.recordFailure(breakerKey);
      const errorOutcome = { error: this.sanitizer(error instanceof Error ? error.message : String(error)) };
      traces.push({ key: execExpr.key, name: "", micros: 0, code: "UDF_ERROR", outcome: errorOutcome });
      return errorOutcome;
    }
  }

  udfFunctionSchemaTools(): unknown[] {
    return this.registry.udfFunctionSchemaTools();
  }
}

export { DecisionRuntime };
