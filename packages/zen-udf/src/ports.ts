// 策略层端口接口（CONTRACT §6）：机制/策略分界的立法化。
// 端口由宿主在组合根（createUdfRuntime）注入，per-tenant 决策由端口实现
// 内部按 tenantId 数据作出——机制层不感知 per-tenant 差异。

/**
 * 出口防护端口（执行规范 §6.3，U9）：按租户校验出口 URL，拒绝时抛错。
 */
export interface EgressGuard {
  assertAllowed(url: string, tenantId: string | undefined): void | Promise<void>;
}

/**
 * 密钥解析端口：图内 auth 值支持 `${secret:名称}` 引用，真实凭证按租户解析，不进图内容。
 */
export interface SecretResolver {
  resolve(ref: string, tenantId: string | undefined): string | Promise<string>;
}

export interface RateCommonResult {
  counter: number;
  v: string;
  idle: number;
  timestamp: string;
}

export interface GroupDistinctCommonResult {
  idle: number;
  pv: number;
  uv: number;
  gidle: number;
  vidle: number;
  group: string;
  v: string;
  timestamp: string;
}

/**
 * 频控存储端口：Redis 化实现（verdict 侧）须通过 rate-store-conformance 契约测试。
 */
export interface RateStore {
  rate(entity: string, windowMs: number, asOf?: number): RateCommonResult | Promise<RateCommonResult>;
  groupDistinct(
    group: string,
    value: string,
    windowMs: number,
    asOf?: number,
  ): GroupDistinctCommonResult | Promise<GroupDistinctCommonResult>;
  reset?(): void;
}

/**
 * 策略层端口聚合（CONTRACT §6）：createUdfRuntime 组合根一次注入。
 * 任一端口 MAY 为 undefined（= 开发态默认放行/不做频控），实现 MUST 面向
 * per-tenant 数据决策。
 */
export interface UdfPorts {
  egressGuard?: EgressGuard;
  secretResolver?: SecretResolver;
  rateStore?: RateStore;
}
