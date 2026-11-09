// HAProxy 计数节点客户端（xrule 协议：GET/POST /<backend>?params）——
// 为 HA 档专用节点（聚集检测 / 近似滑窗计数 / A:B 计分板）提供传输面。
// 协议对照 deploy/haproxy/haproxy.cfg（源 xrule）：
//  - POST/GET /trailing_count_<w>?mykey=<entity>            → {counter, idle, ttl}
//  - POST/GET /trailing_distinct_<w>?group=<g>&distinct=<v> → {gpv, uv, pv, gidle, vidle, gttl}
//  - POST     /scoreboard_<w>?mykey=<entity>&slot=<A|B|AB>  → {a, b}
//    GET      /scoreboard_<w>?mykey=<entity>                → {a, b}（纯读不建键）
// 键摘要（md5）在 cfg 侧完成——客户端发送原始键，原始值不落表语义与 cfg 一致。
//
// 窗口后端段：cfg 须存在对应后端（缺段抛错——能力边界显式化）。

export interface HaNodeOptions {
  /** HAProxy REST 基址（如 http://haproxy:8888） */
  baseUrl: string;
  /** 窗口 ms（缺省 1h）——须与 cfg 后端段一致 */
  windowMs?: number;
  /** 单请求超时 ms（缺省 2000） */
  timeoutMs?: number;
}

const WINDOW_BACKENDS: Record<number, string> = {
  10000: "10s",
  60000: "1m",
  300000: "5m",
  3600000: "1h",
  86400000: "1d",
  604800000: "7d",
};

export type ScoreboardSlot = "A" | "B" | "AB" | "NONE";

export class HaProxyCountNode {
  private readonly baseUrl: string;
  private readonly windowMs: number;
  private readonly timeoutMs: number;

  constructor(opts: HaNodeOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.windowMs = opts.windowMs ?? 3_600_000;
    this.timeoutMs = opts.timeoutMs ?? 2_000;
  }

  private suffix(): string {
    const suffix = WINDOW_BACKENDS[this.windowMs];
    if (!suffix) throw new Error(`windowMs ${this.windowMs} has no haproxy backend`);
    return suffix;
  }

  private async call<T>(path: string, query: string, method: "GET" | "POST"): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${path}?${query}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`haproxy rest ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  /** 近似滑窗计数（POST = 记录并读回；处理时间语义，双桶插值） */
  async approxCount(entity: string): Promise<{ counter: number; idle: number; ttl: number }> {
    const row = await this.call<Record<string, unknown>>(
      `trailing_count_${this.suffix()}`,
      `mykey=${encodeURIComponent(entity)}`,
      "POST",
    );
    return {
      counter: Number(row.counter ?? 0),
      idle: Number(row.idle ?? 0),
      ttl: Number(row.ttl ?? 0),
    };
  }

  /** 聚集检测：group 下 value 的窗口聚集（uv 首见/pv 出现/gpv 组事件 + 三级 idle + ttl） */
  async clusterProbe(
    group: string,
    value: string,
  ): Promise<{ uv: number; pv: number; gpv: number; gidle: number; vidle: number; gttl: number; vttl: number }> {
    const row = await this.call<Record<string, unknown>>(
      `trailing_distinct_${this.suffix()}`,
      `group=${encodeURIComponent(group)}&distinct=${encodeURIComponent(value)}`,
      "POST",
    );
    return {
      gpv: Number(row.gpv ?? 0),
      uv: Number(row.uv ?? 0),
      pv: Number(row.pv ?? 0),
      gidle: Number(row.gidle ?? 0),
      vidle: Number(row.vidle ?? 0),
      gttl: Number(row.gttl ?? 0),
      vttl: Number(row.vttl ?? 0),
    };
  }

  /** A:B 计分：slot 路由递增并读回双计数（NONE = GET 纯读不建键——键污染防护） */
  async scoreboardTally(entity: string, slot: ScoreboardSlot): Promise<{ a: number; b: number }> {
    if (slot === "NONE") {
      const row = await this.call<Record<string, unknown>>(
        `scoreboard_${this.suffix()}`,
        `mykey=${encodeURIComponent(entity)}`,
        "GET",
      );
      return { a: Number(row.a ?? 0), b: Number(row.b ?? 0) };
    }
    const row = await this.call<Record<string, unknown>>(
      `scoreboard_${this.suffix()}`,
      `mykey=${encodeURIComponent(entity)}&slot=${encodeURIComponent(slot)}`,
      "POST",
    );
    return { a: Number(row.a ?? 0), b: Number(row.b ?? 0) };
  }
}
