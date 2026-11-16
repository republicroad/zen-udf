# 实施计划：ExecContext 宿主元数据通道（meta bag）

- 日期：2026-11-16
- 状态：**planned**（宿主评审通过 §8；M1/M2 已折入——M1 落点经核验修订为**远侧**
  冻结，依据见 §9；未实施）
- 提案出处：verdict 宿主草案 `verdict/docs/drafts/upstream-zen-udf-exec-context-meta.md`
  （2026-11-16，proposed——立法地 = 本仓 TS 接口面，自有仓直接排期）
- 关联：CONTRACT.md §6（执行策略边界，落文档处）、§8（BACKWARD minor 发版依据）；
  `packages/zen-udf/src/exec-context.ts`（立法对象）

## 1 · 背景与判据

ExecContext 现役 10 字段全部 case-by-case 逐个立法。下一笔待付成本：verdict-013
三期 scoreboard scope 版本标注需要 `modelId`/`revision`——"模型/修订号"是 verdict
的领域概念，引擎接口不该知道宿主在执行"模型"还是"策略"，case-by-case = 宿主域
概念无限侵蚀引擎接口 + 每次上游发版循环。

**判据（data/control 分离）**：引擎消费的字段（tenantId/replay/shadow/tenantExempt/
observeMemoId/journalId——安全与行为开关）必须强类型第一公民；仅被工具/宿主/审计
消费的数据（userId/requestId/decisionId/eventTime 及一切未来宿主元数据）走开放
通道 `meta`。新增元数据一律先入通道；某键被引擎语义依赖时才升格 typed 字段（需
ADR）。业界先例：OTel Baggage（typed SpanContext + 开放 k/v + "勿用于控制面"
纪律）同构。

设计三要（提案 D1/D2/D3）：

| # | 设计 | 内容 |
| --- | --- | --- |
| D1 | 接口 | `meta?: Record<string, unknown>`，既有 10 字段零改动。三契约：① 引擎语义【不读】；② 值必须可结构化克隆（JSON-able，TSFN serde 边界）；③ 体积建议上限 4KB（实现不强制，超限自担） |
| D2 | 传播与测试 | ALS/TSFN 冻结副本自动同管道；新增测试钉 = 跨冻结副本深相等 + 引擎不读纪律回归守卫 |
| D3 | 升格规则 | meta 键被引擎语义依赖时 MUST 升格 typed 字段并走 ADR——meta 永远只做数据通道 |

## 2 · 探查结论（2026-11-16，HEAD = 0b4522e）

**通道激活零 engine.ts 代码改动**——ExecContext 全部传播站点是对象浅 spread，
meta 作为接口字段自动随管道（§9 M1 远侧冻结是唯一的 engine.ts 改动）：

| 站点 | 位置 | 机制 |
| --- | --- | --- |
| journalId 注入 | `engine.ts:565` | `{ ...execCtx, journalId }` 浅 spread 重建 |
| 冻结嵌入 | `engine.ts:435` | `Object.freeze({ ...execCtx })` 经 `EXEC_CONTEXT_INPUT_KEY` 嵌入输入 |
| TSFN 边界 | zen-engine Rust worker → napi TSFN | serde 整树结构化克隆（journalId/memoId 已验证同管道；meta 值克隆 = 两侧深相等的不同对象） |
| ALS 重建 | `engine.ts:1028` | handleCustomNode 提取后 `runWithExecContext` 重建立 |
| 影子腿 | `engine.ts:631-641` | `{ ...base, tenantId, shadow, observeMemoId }`——meta 自动继承（数据通道宿主可控，灰度双跑正需两腿同 meta） |

**引擎不读在现架构下免费成立**：审计（`emitAudit` engine.ts:468-532 逐字段挑选，
inputHash 用原始入参）、metrics（只取 tenantId）、ToolContext（白名单
tenantId/userId/requestId）、OTel——全部白名单式逐字段消费，无任何 `...ctx` /
`JSON.stringify(ctx)` 全字段展开点。meta 天然不进 inputHash 与审计形态，只需测试钉住。

**注意**：`assertJsonSafeInput`（engine.ts:244-251）只校验原始入参，不覆盖嵌入的
ExecContext——meta 违例（函数/symbol）会在 TSFN serde 边界崩，靠契约文档约束
（D1 契约②），不做运行时校验（见 §5 非目标）。

**冻结现实（§9 M1 核验补充）**：`Object.freeze({ ...execCtx })`（engine.ts:435）为
近侧浅冻结，**不跨 TSFN serde 克隆存活**——工具实际读取的是
`handleCustomNode:914` 提取的每节点全新**未冻结**克隆（2026-11-10 per-node 克隆
实证同源）。既有"冻结"测试为弱断言：`context-hardening.test.ts:86-92` 是纯本地
自检不经管线；`:76` 的 isFrozen 读不存在的 `__ctx` 属性（`void frozen` 死代码）。
即：今天没有任何测试证明远侧副本冻结；近侧"冻结副本防篡改调用方"的实际防护由
serde 克隆本身（改写不回落调用方）提供，freeze 位在跨界后并不存在。

## 3 · 改动清单

| # | 项 | 量级 |
| --- | --- | --- |
| 1 | `packages/zen-udf/src/exec-context.ts`：接口 `journalId` 后新增 `meta?: Record<string, unknown>`，doc comment 承载 D1 三契约 + 升格规则指向，出处引注体例对齐既有字段（Y2/Y3/AA1/批次80 同款）。M2 并入：同文件导出递归 `JsonValue` 类型与 `export type ExecMeta = Record<string, JsonValue>` 可选别名（接口字段声明保持 `Record<string, unknown>` 不强制——宿主选用 ExecMeta 得编译期 JSON-able 检查，运行时零影响），index.ts 补导出 | 极小 |
| 1b | `packages/zen-udf/src/engine.ts` `handleCustomNode`（:914 提取后、:1028 入 ALS 前）：`if (execCtx?.meta) Object.freeze(execCtx.meta)`——M1 篡改面封堵的**远侧**落点（评审原案打近侧嵌入点，经核验证伪，详见 §9）。O(1) 每节点一次（freeze 翻位不深走），serde 克隆对象与宿主原对象无别名 | 极小 |
| 2 | 新测试 `packages/zen-udf/src/exec-context-meta.test.ts`（feature 命名惯例，shadow.test.ts 体例），双钉见 §4 | 小 |
| 3 | CONTRACT.md §6 新增内联版本标注块（体例对齐 1.6.0 egress 声明块）：三契约 + D3 升格规则 + **同名消歧注记**——`ExecContext.meta`（宿主执行通道）≠ §6 声明式出口清单的 `meta.egress.allow`（pack 声明面，UdfPackMeta 域）；发版依据引 §8（"meta 新可选键"已预先列入 BACKWARD minor） | 小 |
| 4 | `packages/zen-udf/README.md` "多租户要点"首行 ExecContext 字段列表补 `meta?`（指向 CONTRACT §6） | 极小 |
| 5 | 版本 `packages/zen-udf/package.json` 2.2.3 → 2.3.0（additive minor，commit 消息尾注版本，072bad8/4599c71 漏 bump 教训） | — |

## 4 · 双测试钉（exec-context-meta.test.ts）

**钉 A — TSFN 克隆保真（深相等）+ 远侧冻结（M1）**：仿 `decision-runtime.test.ts:135-152`
探针回显模式。probe 工具返回 `getExecContext()?.meta`；meta 构造含嵌套对象/数组/
null/unicode/数字；图含**两个** customNode（钉跨节点可达——2026-11-10 TSFN 值克隆
教训）。断言两节点回显 `toEqual` 原始 meta（**禁 toBe**——TSFN 两侧是值克隆的
不同对象）。M1 追加断言（**全部在远侧 UDF 内做**——近侧断言证明不了工具侧防护，
§9；既有 `context-hardening.test.ts:86-92` 为不经管线的弱样板，不效仿）：

- `Object.isFrozen(getExecContext()?.meta) === true`；
- 严格模式 `meta.x = …` 赋值 `toThrow()`（TypeError）；
- 同 customNode 内两表达式（兄弟工具共享同一次 ALS 重建）：前者尝试改写 meta
  抛错后，后者读到的 meta 与原值深相等。

**钉 B — 引擎不读纪律（data/control 分离回归守卫）**：同一图两次 evaluate——
一次 meta 塞对抗性内容（**与 typed 字段同名的键**：`tenantId`/`shadow`/`replay`/
`journalId`/`tenantExempt` 作为 meta 键名 + 较大载荷 + 非法形态值），一次不带
meta。断言：

- 两次 result 深相等；
- 审计事件（onDecision 捕获）形状完全一致，`JSON.stringify(event)` 不含 meta
  内容标记；
- observed 条目白名单键断言（仿 `decision-audit.test.ts:284`：keys ⊆ 既有八字段
  白名单）——meta 不进审计形态；
- 工具第二参 ToolContext 的键不含 meta（白名单透传不回归）。

## 5 · 明确非目标（提案已裁定）

- **ToolContext 不加 meta**——工具经 `getExecContext()?.meta` 单点直达（提案 §6
  否决记录：第二通道无增量收益）；
- **evaluateReplay 不重建 meta**——引擎不读、审计不记，回放腿按需由宿主自带 ctx；
- **不做体积/JSON-ability 运行时校验**——热路径纪律（d6c2f26 先例：不为低频收益
  埋热路径税），契约文档约束；
- **影子腿随 spread 自动继承 meta**——数据通道宿主可控，不另立隔离机制；
- **远侧 ctx 顶层/嵌套层的整体冻结面不扩**（M1 范围裁定）——今天远侧 ctx 整体
  即未冻结（`shadow.prodRev` 等嵌套对象同面）；本次只封 meta 这一**新增**面，
  meta 内嵌套层（`meta.a.b`）一层冻结与 ctx 既有语义同档，跨节点由 per-node
  克隆天然隔离——既有面与深冻升级另立评估。

## 6 · 验证

1. `cd packages/zen-udf && bun run typecheck`（0 错）
2. `bun run test`（vitest，既有 1026+ 全绿 + 新增双钉）
3. 根目录 `bun run test` 全 workspace 回归（contrib 125 不受影响）
4. 人工核对：CONTRACT §6 新块与 §8 BACKWARD 条款互引成立；同名消歧注记在位

## 6.5 · 后续实施：zen-udf 切原生 execution_context 通道（内核通道已随 2.1.9+enriched 落地）

**实仓核验（2026-11-16）**：fork 发布产物 d.ts 已含 `executionContext`（evaluate/safeEvaluate
第三/四参，customNode 回调载荷 executionContext 字段）——**内核侧零待办**，剩余纯
zen-udf TS 层接线：

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | DecisionRuntime.evaluateAsync | 内部 evaluate 调用传第四参 executionContext = ExecContext 全量（含 meta） |
| 2 | handleCustomNode 换读 | `request.execution_context` 替代保留键恢复（ALS 重建立不变） |
| 3 | 三件套退役 | EXEC_CONTEXT_INPUT_KEY 嵌入/剥离/冻结整体移除（passThrough 衰减根治——meta/租户全链直达） |
| 4 | meta 通道 | 随 ExecContext 全量直达，无需单独处理 |

量级半天（纯 TS 接线 + 回归钉复用）。**触发条件**：与 meta 通道同车发版 2.3.0
（meta 字段本批已落，接线随下批）；verdict 侧消费（scoreboard scope@liveRev 标注）
随发版后升级。源头设计：`verdict/docs/drafts/upstream-zen-execution-context.md`
（内核通道提案，2026-10-31——已在 fork 兑现）。

## 7 · 提交路径

additive minor 2.3.0。commit 消息体例：

```
feat(core): ExecContext 宿主元数据通道 meta bag + 远侧冻结——data/control 分离立法
（typed 引擎语义字段不动；引擎不读/JSON-able/4KB 建议三契约；handleCustomNode
远侧 freeze(meta) 封堵同节点工具篡改面——落点核验修订见 design 文档 §9；
TSFN 深相等+不读纪律+远侧冻结测试钉；ExecMeta 可选类型别名；CONTRACT §6
消歧 pack 声明面 meta）——2.3.0
```

出处引 verdict 提案。tag/push/publish（`v*` tag 触发 npm 发布）留宿主决定。

估算合计 ≤0.5 天（接口 + engine.ts 一行冻结 + 双测试 + 文档）。

## 8 · 宿主评审记录（verdict，2026-11-16）

**结论：通过（approve with amendments）**——无阻塞项；M1 建议必纳，M2 可选。

### 证据核验

§2 全部代码锚点实测核对（engine.ts:565 spread / :435 浅冻结嵌入 / :1028 ALS 重建 /
631-641 影子 spread / emitAudit 逐字段挑选 / ToolContext 白名单接口（register.ts:126，
无 `...execCtx` 展开）/ 全仓无 `JSON.stringify(execCtx)`）——「零代码改动激活 + 引擎
不读免费成立（白名单式消费为结构性保证而非现状巧合）」**属实**。

### 亮点

- **钉 B 对抗性设计**：meta 塞 typed 同名键（tenantId/shadow/tenantExempt…）——
  data/control 分离最锋利的回归守卫，优于泛化"行为不变"断言
- **同名消歧注记**：`ExecContext.meta` vs `meta.egress.allow`（pack 声明面）同仓
  碰撞提前在 CONTRACT §6 落位
- **assertJsonSafeInput 不覆盖 ExecContext 的诚实披露**（§2 注意）——未藏进脚注

### 修订建议

**M1（建议必纳，一行改动）**：`Object.freeze({ ...execCtx })` 为**浅冻结**——顶层
字段不可重赋值，但 `meta` 对象本身（嵌套层）保持可变 → 任何工具经
`getExecContext().meta.x = …` 即可改写同请求下游工具可见的元数据。这是 meta 通道
引入的**新增篡改面**（此前顶层冻结使工具改不了任何 ctx 字段；工具为注册制可信面，
风险评级低，但修复同样轻）：

```ts
// engine.ts:435 嵌入点（每次求值一次、小对象——不构成热路径税，
// 与 d6c2f26"不为低频收益埋热路径税"先例不同类）
const embedded = Object.freeze({ ...execCtx });
if (embedded.meta) Object.freeze(embedded.meta);
return { ...(ctx as Record<string, unknown>), [EXEC_CONTEXT_INPUT_KEY]: embedded };
```

配套：钉 A 追加断言 `Object.isFrozen(embed[EXEC_CONTEXT_INPUT_KEY].meta)`。

**M2（可选）**：契约②编译期可选强化——导出别名 `export type ExecMeta = Record<string, JsonValue>`
（递归 JSON 类型），宿主可选用获得 JSON-able 的**编译期**强制；运行时不校验纪律不变。

### 宿主侧备忘（verdict 消费时，非本仓动作）

§5 裁定 evaluateReplay 不重建 meta——scoreboard 版本标注未来消费 `meta.revision`
时，**回放腿（query 类算子 asOf 执行）需宿主在回放 ctx 自带 meta**（否则标注降级）；
verdict 回放构造点届时补传，先记一笔。

### 非阻塞观察

- 影子腿 spread 继承 meta ✓ **正确**——双跑两腿同请求元数据为比对所需的数据语义
- CONTRACT §8 预列 BACKWARD minor ✓
- 测试体例引用的先例文件存在（行号未逐一核对）

### 状态

可进入实施（M1 纳入改动清单 item 1；M2 可选随发版）。宿主（verdict）消费等
2.3.0 发布：构造点 meta 注入 + scoreboard scope@liveRev / cluster_probe scope 接入。

## 9 · 实施响应（zen 侧，2026-11-16）

评审结论采纳：M1 必纳、M2 纳入（三行类型、零运行时影响，成本低于再议一轮）。
**M1 落点经核验修订**——评审原案在近侧嵌入点（engine.ts:435）
`Object.freeze(embedded.meta)`，三点证伪：

1. **近侧冻结保护不到任何工具可见对象**：近侧 embed 唯一下游是 TSFN 跨界本身，
   近侧无其他消费者；工具读取的是 `handleCustomNode:914` 提取的每节点 serde
   克隆——frozen 位不跨 serde 存活（2026-11-10 per-node 克隆实证同源），
   近侧冻结后远侧仍是可变对象；
2. **近侧冻结有宿主别名副作用**：`{ ...execCtx }` 浅拷贝**共享 meta 引用**，
   冻结 embedded.meta 即冻结调用方持有的原 meta 对象——宿主跨请求复用 ctx
   对象并在请求间改写 meta 的合法模式会被误伤；
3. **评审配套断言恰好是原案无效的证明**：`Object.isFrozen(embed[...].meta)`
   若在 UDF 内（远侧）执行，近侧冻结方案下必为 false——该断言只能在远侧
   为真，而远侧为真要求冻结打在远侧。

修订落点（§3 item 1b）：`handleCustomNode` 提取后（:914 之后、:1028 入 ALS 前）
`if (execCtx?.meta) Object.freeze(execCtx.meta)`——冻结的正是工具经
`getExecContext()` 读到的对象；该对象是 serde 克隆，与宿主原对象无别名（第 2 点
副作用消失）；O(1) 每节点一次，不构成热路径税。配套断言全部移到远侧 UDF 内
（§4 钉 A 修订），顺带补上既有冻结测试的缺位（§2 冻结现实注）。

范围裁定：同节点内嵌套层（`meta.a.b`）篡改面不深冻（一层冻结与 ctx 既有语义
同档，`shadow.prodRev` 同面未深冻；跨节点由 per-node 克隆天然隔离）——记 §5
非目标，既有面冻结升级另立评估。

## 9 · 宿主深度评审续（完备性 + 两项新发现，2026-11-16）

### 完备性核验：传播站点穷举闭环 ✓

`EXEC_CONTEXT_INPUT_KEY` 全仓 6 处读写点穷举：**嵌入**（engine.ts:435）→ **提取**
（:914 handleCustomNode 从嵌入输入恢复）→ **passThrough 向下传播**（:999，下游
act 节点依赖）→ **出口剥离**（:569）；影子腿同构（:640 嵌入 / :653 剥离）。无
遗漏站点——§2 探查结论补完为穷举级。

### 新发现 R1（限制披露——建议补入 §3 已知限制条款）

**meta 可达性 = passThrough 链衰减**。上下文以保留键嵌入 input、随 passThrough
向下传播（engine.ts:999 注释自证"下游 act 节点依赖"）——中间 UDF 节点
`passThrough=false` 即**截断 meta 与 tenant**，下游工具 `getExecContext()` 返回
undefined：租户键降级为无租户、scope 标注缺失。这是保留键嵌入机制的固有限制
（upstream-zen-execution-context.md 四问题之一的 verdict 实测复现形态）。

处置建议：本设计文档补"已知限制"条款——**内核通道落地前（upstream-zen-execution-context.md），
meta 与 tenant 同为尽力而为通道**；verdict 配方纪律对齐（UDF 节点 passThrough
模板保证 + 守卫测试）。内核通道落地即根治（上下文走节点上下文不走 input）。

### 新发现 R2（契约④——调用后不可变）

嵌入为顶层浅拷贝、`meta` 嵌套对象**引用共享宿主原对象**：evaluate 进行中宿主
修改 meta 嵌套字段 → 同请求下游工具可见（引擎侧 M1 冻结防的是工具改，防不了
宿主改——同一引用两侧）。

处置建议：契约④立法——"**evaluate 调用后宿主不得修改 meta（视为不可变快照）**"，
与 D1 三契约并列为四契约。若未来要引擎侧根治，嵌入时对 meta 做一次深拷贝
（小对象，µs 级——与 M1 同点同性质，可与 M1 合并实施）。

### 修订汇总（合并 §8）

| # | 项 | 状态 |
| --- | --- | --- |
| M1 | 嵌入点 meta 一层冻结（工具篡改面） | 建议必纳 |
| M2 | ExecMeta = Record<string, JsonValue> 编译期强化 | 可选 |
| **R1** | 已知限制条款：meta 可达性继承 passThrough 衰减（内核通道根治） | **建议必纳（文档条款）** |
| **R2** | 契约④：调用后不可变（宿主纪律立法） | **建议必纳（文档条款）** |
