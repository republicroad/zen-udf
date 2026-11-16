# 排查方案：批次 166 · passThrough 衰减跨节点上下文丢失

- 日期：2026-11-16
- 状态：**已闭环（§7 结论节）**——保留键机制已按宿主指令全面退役（本文 §1/§2
  描述的中间态为历史记录），直切原生 execution_context 通道；内核侧断头一处
  已修复（fork bdebd16），待 fork 发版后链测试转绿
- 发现地：verdict 宿主红测试 `verdict/apps/api/test/passThrough-attenuation.test.ts`
  （批次 166 · R1 实证，工作树未提交）
- 关联：`docs/design/zen-udf-exec-context-meta.md`（§9 宿主深度评审续：R1 衰减限制
  披露 / R2 契约④；本 bug 即 R1 的引擎侧兑现）；`packages/zen-udf/src/engine.ts`；
  `verdict/docs/drafts/upstream-zen-execution-context.md`（内核通道终态草案）

## 1 · 问题陈述

**现象**：ExecContext 以保留键 `__zen_udf_exec_ctx__`（`EXEC_CONTEXT_INPUT_KEY`）
嵌入顶层 input、随数据面（节点输出→下游输入）流动。中间 UDF 节点 `passThrough`
未设（旧行为下截断）或显式 false 时，保留键不再向下传播——下游 customNode 的
`handleCustomNode` 提取不到 ExecContext → `getExecContext()` 为 undefined。

**危害**：
- **租户键降级为无租户空间（跨租户串染）**——velocity 族键构造期取
  `getExecContext()?.tenantId ?? ""`（verdict `udf/velocity/contract.ts:150`），
  下游有状态节点全部落无租户桶；
- **meta 通道失效**——宿主元数据（scoreboard scope 版本标注，verdict-013 三期）
  到达不了截断点下游；
- **直击 ADR verdict-015**——scope 双跑（`租户:scope@版本:entity` 构造性隔离）
  的"零串染"承诺依赖 ExecContext 到达每个有状态节点。

**宿主裁定的修复语义**（红测试头注原文）：**执行环境上下文对所有自定义节点可达，
与 passThrough（仅约束当前节点输出是否透传）正交。**

**修复现状**：修复第一部分已落地本仓（§2），verdict 消费的是 npm `2.2.3`
（`bun.lock` 实证，非 workspace 链接）——**红测试在发版 + 升级前看不到修复**。

## 2 · 基线事实（2026-11-16 探查实证）

### 2.1 git 基线

```
8434c2a chore(core): 移除 DBG_166 调试行（165 批实证遗留）   ← HEAD，工作树干净
374cea3 feat(core): ExecContext meta 通道 + 保留键无条件传播（宿主裁定 实现第一部分）
cbbc1b5 docs(design): exec-context-meta 宿主深度评审续（R1/R2）
5fa084e docs(design): exec-context-meta 实施计划补宿主评审记录
```

### 2.2 已落修复（374cea3，engine.ts）

**保留键无条件传播**（:1002-1018）：UDF 输出构造时，凡节点输入带保留键即写入
节点输出（:1009-1011），与 passThrough 正交；passThrough=true 的通用输入拷贝
循环（:1012-1017）另路同值覆盖（无害）。旧行为（发布 2.2.3 `engine.ts:995`）：
仅 `passThrough` 真值时拷贝输入键——保留键搭便车，false/unset 即截断。

**meta 近侧冻结**（:438-441，enrichInputWithExecContext）——落点错误，见 §5 欠账②。

### 2.3 调试残留（HEAD 已提交，必须清场）

`374cea3` 引入三处 DBG_166 调试产物，`8434c2a` 只移除了 `[DBG handle]` 一处，
**HEAD 仍含两处**（engine.ts:1043-1046）：

```ts
if (process.env.DBG_166) console.log("[DBG als-rebuild]", ...);   // 门控日志
if (execCtx.meta && ...) {
  (execCtx.meta as Record<string, unknown>).__dbg_ref = "als";    // ← 未门控！
}
```

第二处**未门控**：每 customNode 执行即向远侧 meta 克隆写入 `__dbg_ref: "als"`
——污染所有工具可见的 meta（不回落宿主原对象，per-node 克隆隔离，但下游工具
读到脏键）。同时它也是活证据：**远侧 meta 未冻结**（design 文档 item 1b 未落）——
若远侧冻结落地，此行将以 TypeError 炸掉。

### 2.4 欠账三笔（修复完备性缺口，§5 展开）

| # | 项 | 位置 | 性质 |
| --- | --- | --- | --- |
| ① | `key !== "EXEC_CONTEXT_INPUT_KEY"` 字面量比较常量**名**而非常量值——永假死代码 | engine.ts:1014 | 无害但为坑（行为靠 :1009-1011 先写同值碰巧正确） |
| ② | meta 冻结打在**近侧**（:438-441）——design 文档 §9 已证伪：不跨 TSFN serde 克隆存活（远侧仍可变）+ 浅拷贝共享引用会误冻宿主原 meta 对象；正确落点=handleCustomNode 提取后**远侧**冻结（item 1b），未落 | engine.ts | 评审 M1 意图未兑现 |
| ③ | 宿主 R1（已知限制条款）/ R2（契约④调用后不可变）"建议必纳"，design 文档未补 | docs | 文档条款欠账 |

### 2.5 传播机制关键事实（判定树的推理基础）

- **graphAddons 默认值**（engine.ts:728-752）：决策经 `createDecision*` 家族创建时，
  customNode 的 `content.config.passThrough == null` → 归一为 **true**——即"未设"
  形态的图在 zen-udf 托管路径下旧行为也不截断（保留键搭便车）；
- **zen-udf 仓内串行链活证据**：`shadow.test.ts:211-252`（in→c1→c2→out，跨节点
  memo 断言只能靠保留键到达 c2）在发布 2.2.3 上**绿**；
- **zen-engine 无带外通道**：`ZenEngineHandlerRequest` 只有 `node` + `input`，
  handler output 直接成为下游 input（Rust 侧不合并）；passThrough 是纯 zen-udf
  JS handler 侧语义；
- **裸路径与形态限制**：裸 `createDecision().evaluate()` 不 enrich（verdict 匿名
  端点 `index.ts:163-166` 即此形态）；数组/原始值输入无法承载保留键（fail closed
  立法行为，exec-context.ts:71-77）；
- **出口剥离**：evaluateAsync `:576` / evaluateShadow `:660` 统一剥离保留键
  （evaluateMany 经 evaluateAsync ✓）；表达式暴露面：hop-1 节点输入含保留键，
  图表达式理论可读完整 ExecContext（防写不防读——冻结副本；design 文档 R1 性质
  披露，内核通道落地前不修）。

## 3 · 核心悬念（静态矛盾——排查方案的判定树中心）

**verdict 红测试与 zen-udf 仓内串行链测试同形态（customNode passThrough 未设、
经 createDecisionWithCacheKey、串行双跳），结论相反**：

| | 形态 | 结论 |
| --- | --- | --- |
| zen-udf `shadow.test.ts:211-252` | 未设 + graphAddons 归一 true + 旧语义搭便车 | **绿**（2.2.3） |
| verdict `passThrough-attenuation.test.ts` | 未设 + 同归一路径（静态追踪 models.ts:1300） | **标称红**（R1 实证） |

若 graphAddons 归一在 verdict 链路同样生效，红测试在 2.2.3 下理应绿——**两者的
差异点才是真根因**。候选（按可能性排序）：

1. **图 JSON 库存取链路转换**：verdict 图创建端点（POST /graphs）对 UDF 节点
   `content.kind/config` 做了转换/包装，graphAddons 识别路径
   （`node.type === "customNode"` + `content.config`）匹配不上 → passThrough
   未归一（保持 null）→ 旧行为截断；
2. **`$call` 对象形 value 求值失败**：红测试表达式 `value: { $call: "ctx_probe",
   kwargs: {...} }` 对象形（仓内测试多用 `"name;;arg"` 分号串形）——若该形在
   verdict 图链路未被 normalizeOperatorCall 正确转换 → 探针根本没执行 →
   `probeSeen.length !== 2`，失败形态根本不是"上下文丢失"；
3. **execute 端点路径分叉**：图来源/构造点与静态追踪不符（缓存版本路径、
   模型 rev 解析另有分叉）；
4. 红测试断言口径过宽（把 R1 的显式 false 复现泛化到未设场景，而未设场景在
   2.2.3 上本就绿——测试本身此刻不红，只是"修复后语义"的立法钉）。

## 4 · 排查判定树（五阶段，各含退出条件）

### 阶段 0 · 基线钉住（zen-udf，零外部依赖）

| 步 | 动作 | 退出条件 |
| --- | --- | --- |
| 0.1 | 记录 git 基线（HEAD=8434c2a + §2.3 调试残留清单） | 清单入本文档 §2（已完成） |
| 0.2 | `cd packages/zen-udf && bun run typecheck && bun run test` | 既有全绿（1026+），锁定回归基线；任何红 = 修复第一部分本身有回归，先修回归 |

### 阶段 1 · 仓内最小复现矩阵（zen-udf，零外部依赖——闭合静态矛盾）

串行双跳图（in→c1→c2→out）+ 探针工具回显 `getExecContext()` 可达性
（tenantId/requestId 有无）。**表达式沿用红测试的 `$call` 对象形 value**（保真
复现候选根因 2）。四场景：

| 场景 | 中间节点 passThrough | 构造路径 | 2.2.3 旧语义预期 | 修复后预期 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **A** | 未设 | `createDecisionWithCacheKey`（graphAddons 归一 true） | **绿**（搭便车） | 绿 | **A 红 = zen-udf 侧另有 bug**（$call 形转换/传播断点），留仓内深挖 normalizeOperatorCall 与 expr_asts 链 |
| **B** | 显式 `false` | 同上 | **红**（截断本体，R1 原始形态） | **绿**（无条件传播） | 修复正确性的直接钉 |
| **C** | 任意 | 裸 `createDecision().evaluate()` | 红 | **仍红** | 已知形态（无 enrich），非 bug——单列记录（verdict 匿名端点同款） |
| **D** | 任意 | 数组/原始值输入 | 红 | **仍红** | fail closed 立法行为，非 bug——单列记录 |

**决策规则**：A 绿 + B 修复后绿 → zen-udf 语义闭环成立，悬念收敛到 verdict
链路（候选 1/3），进阶段 2；A 红 → 根因在仓内（候选 2），阶段 2 降级为验证性。

矩阵实现建议：临时测试文件（或先以 vitest 单文件跑），结论固化后 A/B 转正为
`passthrough-propagation.test.ts`（阶段 4）。

### 阶段 2 · verdict 链路定位（前置：`docker compose up -d postgres` +
packages/db 迁移；`bun test test/passThrough-attenuation.test.ts`）

| 步 | 动作 | 判定输出 |
| --- | --- | --- |
| 2.1 | 跑红测试，捕获**真实失败形态**：断言挂在哪一行、EXEC 响应日志、`probeSeen` 实际条数与各条 `tenant` 值 | `probeSeen.length=2 且第二条 hasTenant=false` → 真上下文丢失（候选 1/3）；`probeSeen.length<2` 或执行报错 → 探针未执行（候选 2） |
| 2.2 | 图 POST 后 GET 回库 JSON，比对 UDF 节点 `content.kind/config` 形态与 graphAddons 识别路径（`node.type`/`content.config`） | 形态被转换 → 候选 1 坐实，定位转换点 |
| 2.3 | 核对 execute 端点图来源（models.ts:1300 链：库 JSON → createDecisionWithCacheKey，无中间变形） | 另有分叉 → 候选 3 |
| 2.4 | （可选）verdict 临时 `file:` 链接本地 zen-udf，复用 DBG_166 门控日志打点每节点 inputKeys/ctx | 直接观察截断/转换发生点 |

**退出条件**：根因以"候选编号 + 代码锚点 + 复现证据"三元组写入本文档结论节。

### 阶段 3 · 修复完备性审计（与阶段 1/2 并行可推进，zen-udf）

| # | 项 | 动作 |
| --- | --- | --- |
| 3.1 | DBG_166 清场 | 移除 engine.ts:1043-1046 两处残留（含**未门控 meta 写入**——HEAD 在产的 meta 污染源） |
| 3.2 | `:1014` 常量名死代码 | 改 `key !== EXEC_CONTEXT_INPUT_KEY`（常量引用）或整段简化 |
| 3.3 | 远侧 meta 冻结落地（design item 1b） | handleCustomNode 提取后（:921 后、:1047 入 ALS 前）`if (execCtx?.meta ...) Object.freeze(execCtx.meta)`；**同批移除 3.1**（未门控写入会以 TypeError 炸）；近侧 :441 冻结是否保留按 design §9（近侧唯一价值=防宿主别名误冻争议，可一并移除或保留双冻结——实施时按 §9 结论二选一并记录） |
| 3.4 | design 文档条款补齐（宿主裁定"建议必纳"） | R1 已知限制条款（内核通道落地前 meta/tenant 为尽力而为通道——注意：批次 166 修复落地后措辞需更新为"显式 false 不再截断；裸路径/非对象输入仍是限制"）；R2 契约④（evaluate 调用后宿主不得修改 meta） |
| 3.5 | 出口剥离完备性核对 | evaluateAsync :576 / evaluateShadow :660 / evaluateMany（经 evaluateAsync）✓；核对 traceData/audit 无保留键泄漏 |
| 3.6 | 暴露面记录（不修） | hop-1 表达式可读完整 ExecContext（防写不防读）+ 裸路径无上下文——记入 CONTRACT 已知限制，终态=内核通道草案（upstream-zen-execution-context.md，估 1-2 天另排） |

### 阶段 4 · 测试钉 + 发版验收

1. 矩阵 A/B 转正 `packages/zen-udf/src/passthrough-propagation.test.ts`
   （feature 命名惯例；B 用 `passThrough: false` 中间节点钉正交语义）；
2. DBG_166 清场 + §5 欠账 ①②③ 全清 → 全量 typecheck + test 绿；
3. 发版 `2.3.0`（meta 通道 + 无条件传播 + 远侧冻结 + 文档条款同车，
   additive minor，CONTRACT §8 BACKWARD 依据）；
4. verdict 升级 `^2.2.3 → ^2.3.0`（bun.lock 重解析）→ 红测试转绿 → B36 等
   既有套件回归 → verdict 侧红测试提交（含 afterAll 清理行）。

## 5 · 验收标准

- **判定树闭合**：§3 静态矛盾以三元组（候选编号+锚点+证据）定论，无悬案；
- **语义钉**：仓内 A/B 转正测试在 2.3.0 上绿（正交语义有回归守卫）；
- **宿主验收**：verdict 红测试在 2.3.0 上两跳 `hasTenant` 皆 true；
- **清场**：DBG_166 零残留（grep `DBG_166\|__dbg_ref` 为空）；
- **文档一致性**：design 文档 R1/R2 条款与代码实际行为互引成立。

## 6 · 边界与非目标

- **裸 createDecision 路径不修**（无 enrich 是 API 合同——verdict 匿名端点为
  已知形态；若宿主要求覆盖，另立提案）；
- **数组/原始值输入不修**（fail closed 立法行为）；
- **内核通道（execution_context 穿线）不在本批**——结构性终态另排
  （upstream-zen-execution-context.md，1-2 天量级）；
- **本文档只做排查方案**——执行（阶段 0-4）待评审后另行启动。

## 7 · 排查结论（2026-11-16 续：判定树闭合 + 宿主指令转向）

> 本节为执行后结论，优先级高于前文；§1-§6 保留作过程记录（其中保留键
> 无条件传播/meta 近侧冻结等中间态机制已按宿主指令**整体退役**，不再回归）。

### 7.1 宿主指令转向

宿主裁定：**保留键（`__zen_udf_exec_ctx__`）机制全面移除**——执行上下文与
input 混流不利于规则治理与未来作用域隔离；每个自定义节点统一经原生
`execution_context` 通道获取上下文（fork zen 仓库的存在理由）。据此：

- zen-udf `engine.ts`：`enrichInputWithExecContext` 嵌入、出口剥离、:999
  无条件传播、meta 近侧冻结全部移除；`evaluateAsync` 第三参下发 execCtx；
  `handleCustomNode` 从 `request.executionContext` 重建 ALS；
- `exec-context.ts` 的 `EXEC_CONTEXT_INPUT_KEY` 及 fail-closed 立法随保留键退役。

### 7.2 依赖考古：beta.3 收参不送达，内核支持在 stable 2.1.9

| 事实 | 证据 |
| --- | --- |
| zen-udf 原依赖 `2.1.9-beta.3` **不含内核 execution_context 穿线** | fork `git merge-base --is-ancestor f18e5dd f773a37` = NO |
| fork 内核支持（evaluate 第三参 → `evaluate_with_request` → `CustomNodeRequest.execution_context`）**已入 stable 2.1.9**（d7f2b33，2026-11-14 发布） | merge-base = YES；`decision.rs`/`custom_node.rs` 三参/字段俱在 |
| beta.3 的 **typings 声明了 `executionContext` 参数但运行时丢弃**（accept-and-drop） | 安装版 `index.d.ts:453` 有参，handler 实测收不到 |
| npm 不注册 build metadata（semver.clean 剥离） | 注册表版本列表无 `+enriched` 条目，tarball 内 package.json 却是 `2.1.9+enriched`——**fork 永远无法靠 metadata 区分发布，必须真升版本号** |
| 已升依赖 `2.1.9`（解析至 tarball `2.1.9+enriched`）后链测试**仍红** | bun.lock 重解析 + `exec-context-chain.test.ts` 第一跳 tenant=null |

### 7.3 真根因：TSFN 边界断头——napi getter 缺失（判定树候选外）

§3 候选 1-4 全部落空，真根因在**内核→JS 的最后一寸**：

```
ZenDecision.evaluate(ctx, opts, execCtx)          # 送达 ✓
  → evaluate_with_request(context, options, execution_context)
  → CustomNodeRequest.execution_context            # 内核侧 ✓（custom_node.rs:61）
  → TSFN 结构体字段 ZenEngineHandlerRequest { execution_context }   # 过界 ✓
  → #[napi] impl { get node() / get input() ... }  # ← 没有 execution_context getter！
  → JS handler: request.executionContext === undefined   # 断头 ✗
```

`#[napi]` struct 字段对 JS **不可见**（handler 收到 napi 类实例，
`Object.keys(request) = []`，getter 全在原型链）；napi impl 漏写 getter =
数据过界后被丢弃。**实证**：`packages/zen-udf/debug-kernel-channel.ts`
（customHandler 打点）——execution_context 到 Rust 结构体、不到 JS。

**修复**：fork `bindings/nodejs/src/types.rs` 补
`#[napi(getter)] pub fn execution_context()`（commit `bdebd16`）。
napi getter 惯例 **camelCase** → JS 属性名 `executionContext`（`get_field`→
`getField` 同款）；zen-udf 读取点 `executionContext ?? execution_context`
双读兜底。

### 7.4 待办链（fork 发版解锁）

1. **fork 发版**：tag `nodejs-v2.1.10`（fix 型 patch——内核路径已随 stable
   2.1.9 浸泡，getter 是补完性行为修复；build metadata 不入注册表，须真升
   版本号）→ push tag → CI node.yaml 全平台构建发布；
2. zen-udf 依赖 `2.1.9 → ^2.1.10` → `exec-context-chain.test.ts` 转绿
   （两跳 tenant/meta 断言）→ 全量 typecheck + test → 提交迁移 + 测试钉；
3. zen-udf 发版 `2.3.0`（原生通道 + meta 通道同车，additive minor）；
4. verdict 升级 + `passThrough-attenuation.test.ts` 复验（54b79e0）。

### 7.5 已知残留（发版前 zen-udf 工作树状态）

- 迁移代码 + 链测试在**工作树未提交**——commit 纪律：测试红不入册，等 fork
  2.1.10 发版转绿后同批提交；
- `debug-kernel-channel.ts` 为临时诊断脚本，发版验证后删除。
