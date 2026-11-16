# 实施计划：ExecContext 宿主元数据通道（meta bag）

- 日期：2026-11-16
- 状态：**planned**（已评审排期，未实施）
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

**零 engine.ts 代码改动即可激活通道**——ExecContext 全部传播站点是对象浅 spread，
meta 作为接口字段自动随管道：

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

## 3 · 改动清单

| # | 项 | 量级 |
| --- | --- | --- |
| 1 | `packages/zen-udf/src/exec-context.ts`：接口 `journalId` 后新增 `meta?: Record<string, unknown>`，doc comment 承载 D1 三契约 + 升格规则指向，出处引注体例对齐既有字段（Y2/Y3/AA1/批次80 同款） | 极小 |
| 2 | 新测试 `packages/zen-udf/src/exec-context-meta.test.ts`（feature 命名惯例，shadow.test.ts 体例），双钉见 §4 | 小 |
| 3 | CONTRACT.md §6 新增内联版本标注块（体例对齐 1.6.0 egress 声明块）：三契约 + D3 升格规则 + **同名消歧注记**——`ExecContext.meta`（宿主执行通道）≠ §6 声明式出口清单的 `meta.egress.allow`（pack 声明面，UdfPackMeta 域）；发版依据引 §8（"meta 新可选键"已预先列入 BACKWARD minor） | 小 |
| 4 | `packages/zen-udf/README.md` "多租户要点"首行 ExecContext 字段列表补 `meta?`（指向 CONTRACT §6） | 极小 |
| 5 | 版本 `packages/zen-udf/package.json` 2.2.3 → 2.3.0（additive minor，commit 消息尾注版本，072bad8/4599c71 漏 bump 教训） | — |

## 4 · 双测试钉（exec-context-meta.test.ts）

**钉 A — TSFN 克隆保真（深相等）**：仿 `decision-runtime.test.ts:135-152` 探针
回显模式。probe 工具返回 `getExecContext()?.meta`；meta 构造含嵌套对象/数组/
null/unicode/数字；图含**两个** customNode（钉跨节点可达——2026-11-10 TSFN 值克隆
教训）。断言两节点回显 `toEqual` 原始 meta（**禁 toBe**——TSFN 两侧是值克隆的
不同对象）。附带：冻结嵌入副本含 meta 时 `Object.isFrozen(embed)` 仍 true
（一层冻结语义不回归，仿 `context-hardening.test.ts:86-92`）。

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
- **影子腿随 spread 自动继承 meta**——数据通道宿主可控，不另立隔离机制。

## 6 · 验证

1. `cd packages/zen-udf && bun run typecheck`（0 错）
2. `bun run test`（vitest，既有 1026+ 全绿 + 新增双钉）
3. 根目录 `bun run test` 全 workspace 回归（contrib 125 不受影响）
4. 人工核对：CONTRACT §6 新块与 §8 BACKWARD 条款互引成立；同名消歧注记在位

## 7 · 提交路径

additive minor 2.3.0。commit 消息体例：

```
feat(core): ExecContext 宿主元数据通道 meta bag——data/control 分离立法
（typed 引擎语义字段不动；引擎不读/JSON-able/4KB 建议三契约；TSFN 深相等
+不读纪律双测试钉；CONTRACT §6 消歧 pack 声明面 meta）——2.3.0
```

出处引 verdict 提案。tag/push/publish（`v*` tag 触发 npm 发布）留宿主决定。

估算合计 ≤0.5 天（单文件接口 + 双测试 + 文档）。

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
