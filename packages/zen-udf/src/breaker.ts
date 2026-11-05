/**
 * 熔断器端口（执行规范补充，Y5）：per tenantId+udfName 的故障隔离第三件——
 * 连续失败超阈值后打开熔断，快速失败（CIRCUIT_OPEN）避免故障下游拖垮 evaluate worker 池。
 * 机制在本仓（内存参考实现 + 接口契约）；分布式全局视图由宿主（verdict）注入实现。
 */
export interface CircuitBreaker {
  /** 是否允许该 key 的本次调用（false = 熔断打开，快速失败） */
  allow(key: string): boolean;
  /** 成功记账（关闭/重置失败连击） */
  recordSuccess(key: string): void;
  /** 失败记账（连击达阈值 → 打开） */
  recordFailure(key: string): void;
}

interface BreakerState {
  consecutiveFailures: number;
  /** 熔断打开的截止时间（epoch ms） */
  openUntil: number;
}

/** 进程内熔断参考实现：连续失败 failureThreshold 次 → 打开 openMs 毫秒 → 半开放行一次探测 */
export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly openMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    this.failureThreshold = Math.max(1, failureThreshold);
    this.openMs = Math.max(0, openMs);
  }

  allow(key: string): boolean {
    const state = this.states.get(key);
    if (!state || state.openUntil === 0) return true;
    if (this.now() >= state.openUntil) {
      // 半开：放行本次探测（探测成功 recordSuccess 关闭，失败重新计时打开）
      state.openUntil = this.now() + this.openMs;
      return true;
    }
    return false;
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  recordFailure(key: string): void {
    let state = this.states.get(key);
    if (!state) {
      state = { consecutiveFailures: 0, openUntil: 0 };
      this.states.set(key, state);
    }
    if (state.openUntil > 0) {
      // 半开探测失败：重新计时打开
      state.openUntil = this.now() + this.openMs;
      return;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.openUntil = this.now() + this.openMs;
      state.consecutiveFailures = 0;
    }
  }

  /** 观测：key 是否处于打开状态（测试/指标用） */
  isOpen(key: string): boolean {
    const state = this.states.get(key);
    return !!state && state.openUntil > this.now();
  }
}

/** 空实现：不熔断（DecisionRuntime 缺省，零开销） */
export class NoopCircuitBreaker implements CircuitBreaker {
  allow(_key: string): boolean {
    return true;
  }
  recordSuccess(_key: string): void {}
  recordFailure(_key: string): void {}
}
