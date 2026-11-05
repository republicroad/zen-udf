import type { ZenDecision } from "@republicroad/zen-engine";

/**
 * L1 决策缓存（多租户设计 docs/design/zen-udf-multi-tenant.md §3）。
 *
 * 探针实证（src/engine-cache-semantics.test.ts）：zen-engine 函数 loader 无引擎级缓存，
 * 缓存责任在宿主——本类即宿主侧缓存机制：
 *  - 键由 DecisionRuntime 组合（`${tenantId}:${key}@${rev}`），本类只管存取与驱逐
 *  - Map 插入序实现 LRU：get 触碰刷新位次，超容量按最旧驱逐
 *  - 空闲 TTL（BB3）：可选项，get 惰性过期（不引入定时器），与容量上限叠加
 *  - 原子替换语义：set 同键即整体换新（copy-on-write 热更新），绝不原地改
 *  - in-flight 安全：被驱逐条目若仍被请求持有引用，evaluate 不受影响，GC 兜底
 */
export interface CacheMetricsSnapshot {
  hits: number;
  misses: number;
  evictions: number;
  /** 空闲 TTL 过期数（BB3） */
  ttlEvictions: number;
  builds: number;
  buildMicros: number;
  size: number;
}

export interface DecisionCacheEntry {
  decision: ZenDecision;
  content: unknown;
  /** 最后访问时间（epoch ms，TTL/调试用；set 时自动打点） */
  lastAccessMs?: number;
}

export interface DecisionCacheOptions {
  /** 容量上限（条目数），默认 500 */
  capacity?: number;
  /** 空闲 TTL 毫秒（BB3）：条目自 lastAccess 超过该时长即惰性过期；缺省关闭 */
  idleTtlMs?: number;
  /** 时钟注入（测试/指标用）；缺省 Date.now */
  now?: () => number;
  /** 指标 sink：每次 get/set/delete 后回调快照（verdict 接 Prometheus 用） */
  metricsSink?: (snapshot: CacheMetricsSnapshot) => void;
}

const DEFAULT_CAPACITY = 500;

export class DecisionCache {
  private readonly entries = new Map<string, DecisionCacheEntry>();
  private readonly capacity: number;
  private readonly idleTtlMs?: number;
  private readonly now: () => number;
  private readonly metricsSink?: (snapshot: CacheMetricsSnapshot) => void;
  private metrics = { hits: 0, misses: 0, evictions: 0, ttlEvictions: 0, builds: 0, buildMicros: 0 };

  constructor(options: DecisionCacheOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.idleTtlMs = options.idleTtlMs;
    this.now = options.now ?? Date.now;
    this.metricsSink = options.metricsSink;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 命中并刷新 LRU 位次；空闲超 TTL 惰性过期（计 ttlEvictions）；未命中计 miss */
  get(key: string): DecisionCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      if (this.idleTtlMs !== undefined && this.now() - (entry.lastAccessMs ?? 0) > this.idleTtlMs) {
        this.entries.delete(key);
        this.metrics.ttlEvictions += 1;
        this.metrics.misses += 1;
        this.metricsSink?.(this.snapshot());
        return undefined;
      }
      this.metrics.hits += 1;
      // 刷新位次（Map 迭代序 = 插入序，删除再插入即移到最新）+ 空闲时钟重置
      entry.lastAccessMs = this.now();
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      this.metrics.misses += 1;
    }
    this.metricsSink?.(this.snapshot());
    return entry;
  }

  /** 写入/原子替换；超容量按最旧驱逐 */
  set(key: string, entry: DecisionCacheEntry): void {
    const stamped = { ...entry, lastAccessMs: this.now() };
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.metrics.evictions += 1;
      }
    }
    this.entries.set(key, stamped);
    this.metricsSink?.(this.snapshot());
  }

  delete(key: string): boolean {
    const deleted = this.entries.delete(key);
    this.metricsSink?.(this.snapshot());
    return deleted;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 构建计时埋点：DecisionRuntime 在 createDecision 前后调用 */
  markBuildStart(): bigint {
    return process.hrtime.bigint();
  }

  markBuildEnd(startedAt: bigint): void {
    this.metrics.builds += 1;
    this.metrics.buildMicros += Number(process.hrtime.bigint() - startedAt) / 1000;
  }

  snapshot(): CacheMetricsSnapshot {
    return { ...this.metrics, size: this.entries.size };
  }
}
