# @republicroad/zen-udf

zen-engine 的 customNode UDF 核心运行时：**多函数实例执行规范 + UdfPack 注册表 + L1 决策缓存 + 决策审计与确定性回放 + 多租户数据面端口**。

2.0.0 起参考域（velocity/名单/http/号码/IP 等 21 域）迁至 [@republicroad/zen-udf-contrib](https://www.npmjs.com/package/@republicroad/zen-udf-contrib)，本包为纯核心（机制与端口）。

基于 [@republicroad/zen-engine](https://www.npmjs.com/package/@republicroad/zen-engine)（zen 引擎分支，带 **execution context**——请求级上下文送达每个自定义节点 handler，对图表达式不可见），补齐其在服务端执行自定义节点的完整能力。

## 配套与路线

- 引擎：[@republicroad/zen-engine](https://www.npmjs.com/package/@republicroad/zen-engine)——zen 引擎分支（MIT），**execution context**：`evaluate` 的第三可选参把请求级上下文（租户/用户/请求 id）送达每个 customNode handler，对图表达式、结果与 trace 完全不可见（capability 边界），与本包的 `ExecContext` 穿线配套
- **Python 版 zen-udf 规划中**（同语义、PyO3 绑定形态）

## License

MIT

## 定位

zen-engine 原生只执行内置节点类型；本包负责四件事：

1. **执行规范**——customNode 内多函数实例（`udf;;arg;;arg`）的求值、位置参数绑定、必填校验、超时兜底、per-tenant 并发闸与熔断、返回值契约、错误 containment 与脱敏、响应体积守卫（http maxBytes）
2. **决策缓存**——L1 进程内缓存（LRU + 指标），键 `${tenantId}:${key}@${rev}`（zen-engine 函数 loader 无引擎级缓存，缓存责任在宿主——探针实证）
3. **审计与确定性回放**——决策审计事件（onDecision）+ 算子语义三元（query/observe/act）+ journal 回放（observe/act 不重执行）+ 影子评估（evaluateShadow 字段级 diff）+ 输入序列化守卫（NaN/Infinity fail-fast）+ 批量评估（evaluateMany）
4. **多租户上下文与端口**——AsyncLocalStorage 贯穿 evaluate → customNode → UDF（ALS 不跨 TSFN 边界，运行时以输入保留键重建）；数据面端口（RateStore/ConcurrencyLimiter/EgressGuard/SecretResolver）

## 快速上手

```ts
import { DecisionRuntime, type UdfPack, createUdfRegistry, runWithExecContext } from '@republicroad/zen-udf';

const fraudPack: UdfPack = {
  namespace: 'fraud',
  tools: [
    {
      name: 'device_fingerprint_query',
      semantics: 'query', // 算子语义：query | observe | act（缺省 query）
      parametersSchema: { properties: { deviceId: { type: 'string' } }, required: ['deviceId'], type: 'object' },
      returnsSchema: { type: 'object', properties: {} },
      fn: async (kwargs) => queryBackend(kwargs.deviceId as string),
    },
    {
      name: 'block_account',
      semantics: 'act', // 处置动作：宿主提交效果（outbox/幂等键）
      idempotent: true,
      parametersSchema: { properties: { accountId: { type: 'string' } }, required: ['accountId'], type: 'object' },
      returnsSchema: { type: 'object', properties: {} },
      fn: async (kwargs) => submitIntent(kwargs.accountId as string),
    },
  ],
};

const runtime = new DecisionRuntime({
  registry: createUdfRegistry({ packs: [fraudPack] }),
  resultValidation: 'warn', // 返回值契约：off | warn(缺省) | enforce
  limiter: myLimiter, // 可选：per-tenant 并发闸
  breaker: myBreaker, // 可选：熔断器
  metricsSink: (snapshot) => stats.gauge('zen_udf_cache_size', snapshot.size),
  onDecision: (event) => auditLog.write(event), // 决策审计事件（Y2）
});

// 多租户：ExecContext 必须携带 tenantId（单租户 CLI 用 tenantExempt 豁免）
await runWithExecContext({ tenantId: 't-1', userId: 'u-1', decisionId: 'dec-42' }, async () => {
  runtime.createDecisionWithCacheKey('fraud-model', graphJson, 'v3');
  const result = await runtime.evaluateAsync('fraud-model', { deviceId: 'dev-9' }, undefined, 'v3');
});

// 确定性回放（Y3）：observe/act 读审计 journal，query 以 asOf 重算
const replayed = await runtime.evaluateReplay(auditEvent, originalInput);
```

// 确定性回放（Y3）：observe/act 读审计 journal，query 以 asOf 重算
const replayed = await runtime.evaluateReplay(auditEvent, originalInput);

````

## 理想态 API（tool()/pack()/createUdfRuntime）

> ADR-011 理想态：TypeBox schema-as-type（一份构造 = JSON Schema 契约 + 编译期类型）
> + 组合根（端口一次注入）+ examples 即 conformance。旧 API（DecisionRuntime + UdfPack）
> 保留兼容，1.0 移除。

### 声明一个工具

```ts
import { tool } from '@republicroad/zen-udf';
import { Type } from '@sinclair/typebox';

const scoreTool = tool({
  namespace: 'credit',                 // namespace 立法（保留前缀禁用）
  name: 'score',
  description: '信用评分',
  semantics: 'query',                  // query | observe | act
  input: Type.Object({                 // TypeBox schema = JSON Schema + 编译期类型
    income: Type.Number({ description: '月收入' }),
  }),
  output: Type.Object({ score: Type.Number() }),
  examples: [{ input: { income: 8000 }, output: { score: 640 } }], // conformance 即声明
  run: (input) => ({ score: input.income / 10 }),  // input 类型自动推导
});
````

### 声明一个 pack 并注册

```ts
import { createUdfRuntime, pack } from '@republicroad/zen-udf';

const creditPack = pack({
  id: 'credit',
  meta: { origin: 'industry', version: '1.0.0', license: 'proprietary' },
  tools: [scoreTool],
});

const runtime = createUdfRuntime({
  packs: [creditPack],
  ports: {
    // 策略层端口（CONTRACT §6）
    egressGuard: myGuard,
    secretResolver: myResolver,
    rateStore: myRedisStore,
  },
});

// 执行
const result = await runtime.call('credit.score', { income: 8000 });
```

### 端口依赖：集中管理 vs per-tenant 覆写

- **基础设施实现**（EgressGuard 类等）在组合根一次注入——全局唯一，不按租户分实例
- **per-tenant 决策**由端口接口自带的 `tenantId` 参数处理（实现方内部按租户数据判定）
- 类比：一个数据库连接池服务所有租户（查询带 tenantId），不是一个租户一个池

### 旧 API 兼容

DecisionRuntime / UdfPack / registerUdf / registerTools / defineContrib / defineToolFor
保留为兼容桥（JSDoc @deprecated），内部桥接到新 API（当前 1.9.0 仍保留，移除时点另行公告）。

## 算子语义三元

| 语义            | 例                      | 生产执行                                    | 回放行为                     |
| --------------- | ----------------------- | ------------------------------------------- | ---------------------------- |
| `query`（缺省） | 查询、加密、属地        | 读                                          | 正常执行（时钟 = asOf）      |
| `observe`       | rate_1h、group_distinct | 观测即计数（含当前事件，原子）              | **不重执行**，读审计 journal |
| `act`           | 拉黑、通知              | 执行并 journal outcome（幂等键 decisionId） | **不重执行**，读审计 journal |

journal 缺失时 fail closed（`REPLAY_JOURNAL_MISS`）——宁可回放失败，不可静默给出新值。

## 决策审计事件

```ts
new DecisionRuntime({
  onDecision: (event) => auditLog.write(event),
  // event: { decisionId, tenantId, key, rev, inputHash, output, asOf, processingTime, source, observed[] }
});
```

- `inputHash` = sha256(input)（数据最小化）；`output` 为完整决策结论（宿主裁决 D11）
- `observed[]` 携带每个 UDF 的返回值快照——回放 journal 的数据来源，也是"为什么当时是这个决策"的证据

## 端口（机制在本仓，策略在宿主）

| 端口                 | 用途                               | 参考实现 / 生产实现                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `RateStore`          | 滑动窗口频控（as-of 事件时间）     | `InMemoryRateStore`（开发态）→ Redis 实现，复用 `rateStoreConformance` 契约测试 |
| `ConcurrencyLimiter` | per-tenant 并发闸                  | `InMemoryConcurrencyLimiter`（FIFO）/ `NoopConcurrencyLimiter`                  |
| `CircuitBreaker`     | 熔断（连败打开→半开探测）          | `InMemoryCircuitBreaker` / `NoopCircuitBreaker`                                 |
| `EgressGuard`        | http UDF 出口 allowlist（防 SSRF） | 未配置 = 全拒（fail-closed 安全缺省）                                            |
| `SecretResolver`     | 图内 `${secret:名称}` 按租户解析   | 未配置 = secret 引用报错                                                        |

## 影子评估与批量评估

````ts
// 影子评估：新旧 rev 并行执行，act 影子侧返回 intent 占位（不双次处置）
const shadow = await runtime.evaluateShadow('fraud-model', { prod: 'v2', shadow: 'v3' }, input);
console.log(shadow.equivalent, shadow.differences); // 不一致率达标后切流

// 批量评估：同模型多输入并发，逐条错误隔离
const results = await runtime.evaluateMany('fraud-model', [
  { input: { x: 1 }, rev: 'v2' },
  { input: { x: 2 }, rev: 'v2' },
]);
``

其他 0.4.0 能力：L1 缓存空闲 TTL（`idleTtlMs`）、http UDF 响应体积守卫（`maxBytes`）、统一观测 sink（`metrics`，UDF/熔断/并发闸事件）。

## 参考函数域（builtin reference）

根导入自动装载 contrib 参考域（21 域 54 工具）：velocity 频次族（record/stats/ratio）、`list_match` 名单、`http_request`（egress 门控）、intl-phone（E.164/归属地/运营商）、IP 族（canonical/private/cidr）、identity（email）、notify、crypto、ab-bucket、datetime、geo、debug、validate-cn 等。实例隔离用 `new UdfRegistry()` + `loadReferenceInto(registry)` 按需装载。

## 多租户要点

- `ExecContext { tenantId, userId?, requestId?, decisionId?, eventTime?, replay? }`：evaluate 入口强制 tenantId
- 注册是 deploy-time 静态行为；租户差异经 ExecContext + 端口解析
- 编译产物租户无关（同租户同模型共享缓存），数据面租户相关

## 设计文档

- [多租户最佳实践设计](../../docs/design/zen-udf-multi-tenant.md)
- [U 系列开发计划（机制与租户契约）](../../docs/design/zen-udf-development-plan.md)
- [上下文跨 TSFN 边界传播](../../docs/design/zen-udf-context-propagation.md)
- [同步硬实时计数调研（read-my-own-write）](../../docs/design/zen-udf-sync-counting.md)
- [Y 系列计划（语义/审计/回放）](../../docs/design/zen-udf-plan-y.md)
- [包内命名规范](./docs/naming.md)

## 测试

```bash
bun run test   # 1100+ tests（vitest），Bun 工具链（zen-engine 原生绑定）
````
