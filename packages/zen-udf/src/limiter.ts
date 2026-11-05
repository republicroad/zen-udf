/**
 * 并发闸端口（执行规范 §6.3）：per-tenant UDF 并发上限，防单租户打满
 * evaluate worker 线程池。机制在本仓（内存参考实现 + 接口契约），真实语义
 * （分布式/Redis 化配额）由宿主（verdict）实现注入。
 */
export interface ConcurrencyLimiter {
  /** 获取 key（通常是 tenantId）的一个槽位；返回释放函数，必须调用恰好一次。实现须 FIFO 公平 */
  acquire(key: string): Promise<() => void>;
}

interface SlotState {
  active: number;
  /** 等待队列（FIFO）：resolve 后调用方获得槽位 */
  queue: Array<() => void>;
}

/** 进程内信号量参考实现：每 key 最多 maxPerKey 个并发，FIFO 排队 */
export class InMemoryConcurrencyLimiter implements ConcurrencyLimiter {
  private readonly slots = new Map<string, SlotState>();

  constructor(private readonly maxPerKey = 5) {
    this.maxPerKey = Math.max(1, maxPerKey);
  }

  async acquire(key: string): Promise<() => void> {
    let state = this.slots.get(key);
    if (!state) {
      state = { active: 0, queue: [] };
      this.slots.set(key, state);
    }

    if (state.active < this.maxPerKey) {
      state.active += 1;
      return this.releaseOf(key);
    }

    return new Promise((resolve) => {
      state!.queue.push(() => resolve(this.releaseOf(key)));
    });
  }

  private releaseOf(key: string): () => void {
    return () => {
      const state = this.slots.get(key);
      if (!state) return;
      const next = state.queue.shift();
      if (next) {
        // 槽位直接移交队首（active 数不变）
        next();
      } else {
        state.active -= 1;
        if (state.active === 0 && state.queue.length === 0) {
          this.slots.delete(key);
        }
      }
    };
  }

  /** 观测：某 key 当前活跃并发数（测试/指标用） */
  activeOf(key: string): number {
    return this.slots.get(key)?.active ?? 0;
  }
}

/** 空实现：不限并发（DecisionRuntime 缺省，零开销） */
export class NoopConcurrencyLimiter implements ConcurrencyLimiter {
  async acquire(_key: string): Promise<() => void> {
    return () => {};
  }
}
