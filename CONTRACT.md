# zen-udf Tool Contract Specification（工具契约规范）

- 版本：**1.0.0**（随 zen-udf 1.0.0 冻结；本规范的变更遵循 §8 演进规则；契约版本号独立于 zen-udf 包版本）
- 状态：基石规范——zen-udf 各语言实现（当前 TypeScript 参考实现 + 未来移植版）的
  统一约束；多语言移植的验收 = 通过 §7 conformance 全量 fixtures
- 语言：本规范语言中立；规范性（normative）部分以 MUST/SHOULD/MAY 表述（RFC 2119 语义）
- 出处：ADR-009（生态分层/namespace 立法/语义三元）、ADR-011（参数声明统一/defineTool）、
  执行规范 §6（U7）、861 例回归语料与 A3 端点实测教训

## 1. 定位与范围

本规范约束 zen-udf 生态中**自定义函数工具**的：声明契约（§3）、组织与注册（§4）、
执行语义（§5）。不约束：表达式语言语义（见 zen-expression 及其回归语料）、执行策略
的**实现**（超时/并发/出网控制属端口注入，见 §6）、宿主的租户与权限模型。

一个语言实现（reference implementation 或移植版）要自称「zen-udf 兼容」，MUST 通过
§7 的 conformance fixtures 全集。

## 2. 术语

- **Tool（工具）**：最小可注册单元 = 声明契约（§3）+ 处理器（handler）；
- **Pack（包）**：工具的命名集合 + 包元数据，可序列化为语言中立 JSON；
- **Registry（注册表）**：运行时持有已注册工具的容器，提供 §5 三动作；
- **规范表示（canonical representation）**：注册后运行时内部持有的唯一表示——
  JSON Schema 形态的 input/output 契约 + 语义与元数据字段。任何声明形态
  （§3.3 的便利形态）MUST 在注册期归一化为规范表示；运行时读点 MUST 只消费规范表示。

## 3. 工具声明契约

### 3.1 身份

| 字段          | 类型    | 约束                                                                                                                                                  |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`   | string  | 非空；MUST NOT 使用保留前缀（`zen`/`core`/`reference`/`builtin` 的精确名或点分前缀，ADR-009 立法）；行业/宿主包 MUST 带 `{pack-id}.{domain}` 形态前缀 |
| `name`        | string  | namespace 内唯一；跨 namespace 重复 → 注册失败，除非该工具显式 `overwrite`                                                                            |
| `title`       | string? | 目录显示名（缺省用 name）                                                                                                                             |
| `description` | string  | 第一行为摘要（目录卡/补全悬浮用）                                                                                                                     |

### 3.2 语义与治理

| 字段         | 类型                                                                                    | 约束                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantics`  | `query` \| `observe` \| `act`                                                           | 缺省 `query`。query=纯读；observe=观测累积（回放读 journal 不重执行）；act=处置效果。**act 工具 MUST 声明 `idempotent: boolean`**（缺失 = 注册失败） |
| `idempotent` | boolean?                                                                                | 仅 act 语义有意义：true=重放安全                                                                                                                     |
| `deprecated` | `{since?, note}?`                                                                       | 弃用标记：目录/补全/校验告警 MUST 透传                                                                                                               |
| `meta`       | `{origin: reference\|extension\|industry, version: string, license?: oss\|proprietary}` | pack 级元数据（ADR-009 最小集纪律：字段一旦发布即兼容面，只减不增需重大版本）                                                                        |

### 3.3 参数与返回值契约

- `input`：**JSON Schema 对象**（`type: 'object'` + `properties` + `required`）——
  唯一契约来源；位置参数序 = `properties` 键序（实现 MUST 保持键序稳定）；
- `output`：JSON Schema 对象，返回值契约（校验语义见 §5.4）；
- **required 语义**：`required` 数组中的属性为必填；`required` 数组是必填性的
  **唯一权威**（无 default 不隐含必填——对齐 JSON Schema 标准语义；有损派生是历史
  缺陷，见 ADR-011 评审注记）；实现 MUST NOT 丢失 required 信息；
- **便利声明形态**（MAY 提供，语言本地）：扁平 `parameters: {名: {type, description,
default}}` 等。任何便利形态 MUST 在注册期归一化为 input JSON Schema：
  扁平无 default = 必填（进 `required`）；键序保留；`required` 数组显式给出时以
  schema 为准。**声明形态可自由并存，内部规范表示唯一**。

### 3.4 处理器与执行上下文

- 处理器签名（语义形态）：`run(input, ctx) -> output | Promise<output>`；
  `input` 为 §3.3 input schema 校验后的值；`ctx` 为执行上下文（tenant 标识、超时
  信号、日志等），由运行时注入——**执行策略不进处理器签名、不进声明契约**（§6）；
- 处理器 MUST 纯依赖 `input` 与 `ctx`（query 语义）；act 语义的副作用 MUST 满足
  `idempotent` 声明。

### 3.5 examples（conformance 即声明）

工具声明 MAY 携带 `examples: [{input, output}]`（合法 JSON 值，非 JSON5）。每个
example 生成三条 conformance 断言（§7）：input 经 §5.2 校验通过、§5.3 绑定逐字段
等于 input、§5.4 调用结果等于 output。**examples 是跨语言 conformance 的首选来源**；
无 examples 的工具不参与自动 conformance（仍受 §5 语义约束）。

## 4. Pack 组织与注册

- Pack = `{ id, namespace 根, meta, tools[] }`，MUST 可序列化为语言中立 JSON
  （多语言移植的交换形态；处理器以引用/注册函数形式随语言落地）；
- 注册语义（deploy 期，fail fast）：
  - 形状校验失败 → 整体失败；
  - namespace 保留前缀违例 → 失败；
  - pack namespace 重复 → 失败；
  - 跨 pack 工具名重复 → 失败并**列出已注册来源 namespace**，除非工具显式
    `overwrite`（后注册者覆盖）；
  - act 工具缺 idempotent → 失败（0.x 为警告，1.0 冻结为失败）；
- 注册入口唯一（语言实现 MAY 保留旧入口为兼容桥，MUST 打弃用告警）。

## 5. 执行语义

运行时对每个工具 MUST 提供三动作，语义如下（错误码为 normative）：

### 5.1 位置参数序

`parametersOrder(schema)` = input schema `properties` 的键序。位置调用约定按此序。

### 5.2 validate(input | positional args) → 错误清单

- 缺必填属性（对象式调用）或缺必填位置参数（位置式调用）→ `INVALID_PARAM` 错误，
  **MUST 列出参数名与位置**；
- 显式 `overwrite` 的 schema 子树（复杂类型：嵌套/anyOf/$ref/联合 type）不参与
  位置绑定与类型矫正，MUST 在校验结果中标注「无位置绑定」；
- 任何缺失/类型错误 MUST 结构化返回——**禁止静默填充**（空串/零值/undefined 回退
  均为规范违例）。

### 5.3 bind(input | positional args) → kwargs

- 必填缺失且无 default → 错误（与 validate 同源）；
- 有 default → 回退 default；
- 类型矫正按属性声明的简单 `type`（string/number/boolean）；复杂类型原样透传；
- **MUST NOT 用空值/空串补位必填**。

### 5.4 call(input, ctx) → output | 结构化错误

- 流程：validate → bind → 处理器 → （可选）output 契约校验；
- 错误码（normative）：

| 错误码               | 语义                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `INVALID_PARAM`      | 参数缺失/类型违例（§5.2，列参数名与位置）                              |
| `UDF_TIMEOUT`        | 超时端口触发                                                           |
| `INVALID_RESULT`     | 返回值契约违例（output schema 断言；运行时档位可配 warn/enforce）      |
| `UDF_LIMITED`        | 并发闸拒绝                                                             |
| `UDF_ERROR`          | 处理器自身错误（原始错误经脱敏）                                       |
| `CYCLE_DETECTED`     | 实例依赖环（§11.5，执行前结构化错误，列环上输出键）                    |
| `DUPLICATE_OUTPUT`   | 输出键重声明（§11.5，行内变量重声明）                                  |
| `INVALID_DEPENDENCY` | 依赖前驱实例失败，本实例不执行（级联传播）                             |
| `RATE_NO_EVENT_TIME` | 状态算子回放强制（§13.2）：processing 工具遇 replay.asOf 且策略 strict |

- **脱敏**：错误信息 MUST 经脱敏管道（路径/凭证类值替换为占位）后暴露。

## 6. 执行策略边界（机制/策略分界）

超时、并发闸、出网控制（EgressGuard）、secret 解析、重试**不属于本契约**——它们是
宿主经端口注入的执行策略（RateStore/ConcurrencyLimiter/EgressGuard/SecretResolver，
ADR-009/执行规范 §6.2-6.4）。语言实现 MUST 提供这些端口的接入点；端口实现可随
部署后端语言不同。契约只约束：端口触发时错误码语义（§5.4）与 ctx 的字段约定。

**声明式出口清单（1.6.0，可选面）**：`meta.egress.allow`（域名模式：
`example.com` 精确 / `*.example.com` 通配，无 scheme/路径，无 `*` 全通）是 pack
对其网络出口的**声明**（Figma networkAccess / Chrome host_permissions 同族）——
声明是数据不是强制：策略裁定权仍归 EgressGuard 端口，机制层提供
`registry.udfEgress(name)` 查询与 `egressHostMatches(allow, url)` 纯匹配器，
宿主组合根据此做**交叉校验**（声明 ⊆ 租户运行时白名单；guard 可收紧到声明内，
声明外默认拒绝属宿主策略）。未声明的 pack = 无声明面（现状行为零变化）。

## 7. Conformance 协议

- **fixtures 格式**（语言中立 JSON）：

```json
{
  "contract": "0.1.0",
  "cases": [
    {
      "tool": { "/* 声明契约 §3 */": "..." },
      "actions": [
        { "action": "validate", "args": [], "expect": { "errors": ["income is required (position 1)"] } },
        { "action": "bind", "args": [600, 8000], "expect": { "kwargs": { "base": 600, "income": 8000 } } },
        { "action": "call", "input": { "base": 600, "income": 8000 }, "expect": { "output": { "score": 640 } } }
      ]
    }
  ]
}
```

- **移植验收**：全量 fixtures 通过 = 兼容实现；工具声明携带的 `examples`（§3.5）
  自动编译为 fixtures；
- **fixtures 即规范的遗嘱**：规范文档修订 MUST 同步 fixtures；冲突以 fixtures
  为准（可执行）。

## 8. 版本与演进

- 契约版本独立语义化：**破坏性变更升 major， additive 升 minor**；
- zen-udf 1.0 冻结条件：本契约 major=1 + 端口面（§6）冻结——此后声明字段与错误码
  只进不退；
- 语料与 fixtures 随上游（gorules/zen）基线滚动更新；实现升级 MUST 先过全量
  conformance 与回归语料；
- **兼容级（1.6.0 立法，Confluent BACKWARD/FORWARD 同族）**：
  - **BACKWARD（minor）**：additive 可选字段（meta/journal/ctx 新可选键）、新
    错误码、新子路径导出、新语义分支（旧图/旧审计行为零变化）——消费方自由升级；
  - **FORWARD（消费方义务）**：消费方 MUST 容忍未知字段（meta/journal/observed/
    fixtures 报告的未知键不报错）——本章各结构体的新增字段依赖此义务才构成 minor；
  - **BREAKING（major）**：导出移除/改名、字段类型收窄、已文档语义的行为变更、
    fixtures/错误码形状变更——MUST 升 major 并在变更记录中给出迁移路径；
  - **门禁**：CI 公共面 diff（`scripts/contract-compat.mjs`）对上一已发版逐名
    比对导出面，检测到移除/改名而版本号未升 major 即 fail。

## 9. 参考实现状态

| 语言       | 状态                                                                                | 位置      |
| ---------- | ----------------------------------------------------------------------------------- | --------- |
| TypeScript | 参考实现（0.11.0 起对齐本规范：tool()/pack() + R1 直读规范表示 + conformance 导出） | 本包 src/ |
| 其他语言   | 未开始；触发 = 真实部署后端语言出现                                                 | —         |

## 10. 测试契约（决策夹具与执行器）

决策级测试夹具（fixtures）是跨仓交换物（verdict 存库、编辑器消费、CI 验证），
形状与执行器契约立于此节。与 §7 的区别：§7 是**工具级**三动作 conformance
（validate/bind/call），本节是**决策级**端到端执行（整图求值 + 断言）。

### 10.1 夹具（DecisionFixture）

```json
{
  "name": "正常 GOLD 用户",
  "input": { "customer": { "tier": "GOLD" } },
  "asOf": "2026-10-01T00:00:00Z",
  "journal": [{ "key": "flag", "name": "flag_udf", "outcome": { "flagged": false } }],
  "expect": { "mode": "deep", "value": { "tier": "GOLD" } }
}
```

- `expect` **可选**——缺省即 **smoke 语义**：`passed = 执行无异常`（示例天然是
  smoke 用例，可逐个「毕业」为断言用例）；
- `expect.mode`：`deep`（结果深比较）/ `path`（结果路径取值比较）/
  `expression`（zen-expression 对结果求值，可序列化）。**求值契约（OQ3 ①
  定稿，1.4.0）：context 平铺**——对象结果的顶层键即变量（`score.value == 5`
  裸键直引）；非对象结果绑定为 `result` 单键（`result == 42`）。**禁用 `$` 根
  与 `$.path` 导航**——独立求值环境不绑定 `$`，路径 miss 恒 null 静默
  （ADR-014 OQ3 修订增补；1.3.x 的 `result.xxx` 包装形态废弃，存量条件改裸键）；
- `mode: "predicate"`（函数体断言）是**进程内便利糖，不在本契约内**（不可跨端
  序列化）；
- `journal` + `asOf`：Y3 回放语义——observe/act 从桩读回不重执行，夹具可复现；
- **回放钉扎（1.5.0）**：journal 条目可携带 `packVersion`（审计 observed 透传，
  版本源 = 函数所属 pack 的 `meta.version`）——回放时与当前注册表比对，不一致
  即 `REPLAY_PIN_MISMATCH` fail visible（防 pack 升级后回放静默漂移；缺省不参与
  钉扎，存量审计回放行为不变）。夹具报告携带 `fingerprint`（FNV-1a，非加密，
  夹具集漂移检出）。

### 10.2 执行器（DecisionTestExecutor）

```
executor(fixture, index) → { result?, error?, durationMs?, traceHits? }
```

- runner（`runDecisionTests`）只依赖本契约，零引擎依赖——执行/租户/回放/追踪
  全部在 executor 实现（服务端 runtime 适配器 / 浏览器 simulateHandler 适配器 /
  mock，同语义）；
- `traceHits` = 命中节点 id 数组（executor 自行对齐来源语义）。

### 10.3 报告（FixtureReport）

- 聚合：`{ passed, failed, results[] }`；单条 `FixtureResult` 含
  `outcome: "passed" | "assertion-failed" | "execution-error"`（断言失败与
  执行错误分家）+ `durationMs` + `traceHits`；
- 并发缺省 1——act 类算子有副作用，并发是显式选择。

### 10.4 版本纪律

- 夹具文档**存库/跨端交换时携带 `contractVersion`**（信封层，同 §8 纪律）；
  运行时返回值（FixtureReport）不携带（形状随包版本走）；
- 破坏性变更（删字段/改语义）升 major 并附迁移注记；additive 升 minor。

## 11. 调用形态（自定义函数节点的调用规范）

函数节点在图内的调用表达式形态立法（ADR-015）。**记法定案：`$` 前缀信封保留字**
——`$call`/`$positional` 与参数键永不碰撞（对齐 json-logic/json-e/MongoDB 的
`$` 标签对象行业约定）。

### 11.1 规范形（canonical，编辑器写路径目标态）

```json
{ "$call": "pack.function", "kwargs": { "base": 600, "income": 8000 } }
```

- 具名、顺序无关、schema 可校验——位置数组「中插参数静默错位」类失败根除；
- `kwargs` 键 = `parameters.properties` 键（§3 契约）。

### 11.2 兼容形（读取/解析层长期接受，无截止）

| 形态                          | 例                             | 归一                            |
| ----------------------------- | ------------------------------ | ------------------------------- |
| 具名平面（legacy）            | `{"$call": "fn", "base": 600}` | 除 `$call` 外键即参数           |
| 位置数组                      | `["fn", 600, 8000]`            | 按 properties 键序映射为具名    |
| 表达式字符串（`;;`/调用语法） | `"fn;;600;;8000"`              | 经 parseOperatorExpr 同执行路径 |

归一规则（`normalizeNamedCall`，与执行语义同源）：**结构归一、值不造**——
映射不上的位置值原样收进保留键 `$positional`（供编辑面漂移带按 extra 检出）；
不可解析返回 null。`kwargs` 键为普通 Record 时按信封解释（歧义形态信封胜出，
迁移规范形即消除）。

- **行为变化警示（双读的唯一已知破坏点）**：平面调用向名为 `kwargs` 的参数传
  Record 值——0.13 前绑定成功，0.14 起按信封解释（对声明的 kwargs 参数是
  未声明键 → INVALID_PARAM）。检出器：
  `DecisionRuntime.detectKwargsEnvelopeAmbiguity(value, parametersSchema)`，
  编辑面漂移带 MUST 消费之并提示迁移规范形
  （`{$call, kwargs: { kwargs: {...} }}`）。

> **kwargs 值中 `$.` 前缀路径非属性访问**：kwargs 求值域不接通 dollar 作用域
> （standalone 绑定无 insert/set_reference 注入）——值以 `$.` 开头的表达式串
> 求值恒 null。字段引用用**裸键/点路径**（`fieldx` / `a.b`）或 **reference 信封** > `{mode:'reference', value:'path'}`。表达式节点与 dt 单元格的 `$` 可用
> （isolate 已接通）——三面边界表见
> `packages/zen-udf/docs/dollar-scope-decision.md`（多语言移植 MUST 复现）。

### 11.3 弃用表

| 形态                     | 写入                                           | 读取                 |
| ------------------------ | ---------------------------------------------- | -------------------- |
| 规范形 `{$call, kwargs}` | **目标态**（编辑器 0.14+ 切换）                | 永久                 |
| 具名平面                 | 弃用（随 0.14）                                | 永久（旧图存续义务） |
| 位置数组                 | 弃用（随 0.14；简写便利由编辑器 parse 层继承） | 永久（旧图存续义务） |
| 表达式字符串             | 弃用沿 ADR-011 路径                            | 永久                 |

**写路径切换前置（编辑器切规范形的硬时序）**：全部图消费 kernel（verdict
引擎面/旧版 seal 包）MUST ≥ 0.14 方可切换——规范形信封在 0.13 引擎会被当作
名为 kwargs 的平面参数错绑（反向不兼容：新读旧可以、旧读新不行）。

### 11.4 按名校验

`validateNamedArgs(name, kwargs)` → `{ missing, extra, typeMismatch }` 三类
结构化清单——位置校验（§5.2）的具名对应物，与编辑面参数漂移带同构（编辑时
孪生）。执行面语义不变：`required` 缺参 = 执行错误（§5.3）；编辑面漂移带的
默认填充是**创作辅助**，两层不互代。

### 11.6 参数值信封（TypedValue，模式显式化）

kwargs 值 / `$positional` 元素可为信封对象——**模式显式化的 opt-in 通道**
（裸字符串恒按表达式求值的默认不变，引号惯例长期共存）：

```jsonc
{ "mode": "literal",    "value": "($.customer)" }   // 字面量：原样绑定，不求值
{ "mode": "expression", "value": "$.vip ? 'a' : 'b'" } // 表达式：求值
{ "mode": "reference",  "value": "customer.tier" }  // 引用：按路径求值（首期 ≡ expression）
```

- **窄识别（normative）**：自有键**恰为** `mode`+`value` 二键、`mode` ∈ 上三枚、
  `value` 为原始类型（literal 允许 string/number/boolean；expression/reference
  要求字符串）——否则非信封，按现状处理（对象字面量透传，§5.2 报类型不符）；
- **嵌套禁止**：信封 `value` 不再嵌信封；`literal` 的 object/array value =
  非信封透传（校验面报类型不符，OQ2）；
- **保留字**：对象值的 `mode`/`value` 二键自此保留（手写图注意）；
- **依赖提取**：literal 信封不含引用（替换器与提取器均跳过）；expression 提取
  `$.refs`；reference 取路径根段；
- `validateNamedArgs` mode 感知：literal 按声明类型直校；
  expression 静态校验不做（执行错误语义覆盖，OQ4）。

### 11.5 实例依赖调度（行内顺序求值）

函数节点实例（`expressions[]`）默认并行（零行为变化）；声明依赖才串行——
**DAG 调度：声明边才有序，无边即并行**，混合形态合法。

- **依赖声明双通道（并集）**：①自动建图（规范路径，UI 零操作）——从实例
  实参字符串提取 `$.key` 根引用（嵌套访问 `$.a.b` 归根实例 a；解析器与执行
  同源）；②显式 `dependsOn: [key]` 逃生门（解析器覆盖不到的场景）；
- **静默引用不作依赖**：引用未连边的输出键 = 悬空引用（编辑面漂移带检出），
  引擎不自动补边——防「看似并行实则串行」的不可见退化，执行图可审计；
- **执行前结构化错误**：输出键重声明（`DUPLICATE_OUTPUT`）与依赖环
  （`CYCLE_DETECTED`，含自引用）报错非死锁；
- **失败传播**：前驱实例失败 → 依赖实例不执行，收 `INVALID_DEPENDENCY`
  （级联）；**执行语义单源**——依赖实例的求值上下文 = nodeInput ∪ 已完成
  前驱输出（输出遮蔽同名输入，对齐表达式节点行内求值），`$.dep` 引用在
  执行前替换为裸键（仅对已完成依赖键、词边界精确）；
- **零边快路径**：无依赖边 = 单层全并行（原 `Promise.all` 直通，零开销）；
- **调度器单源**：Y3 回放与执行共用同一调度序（拓扑序回放防垫回错位）。

## 12. 一致性档位（Conformance Profiles，1.0 验收基准）

zen-udf 实现按三档验收；档位递增累积（B 含 A，C 含 B）：

| 档位                       | 覆盖面                                                                                            | 验收                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- |
| **Profile A · 核心执行**   | §3 声明契约 + §5 执行三动作（validate/bind/call）+ §11 调用形态双读 + §10 夹具契约                | §7 全量 fixtures 通过     |
| **Profile B · 信任链**     | A + Y3 回放（journal 垫回/asOf/REPLAY_JOURNAL_MISS fail-closed）+ 审计哈希链与 journalDigest 重算 | §10 夹具 + 回放一致性断言 |
| **Profile C · 服务端全量** | B + 多租户 ExecContext + 端口面（§6）+ 实例依赖调度（§11.5）+ breaker/limiter/审计                | 全量 1100 用例            |

多语言移植版按目标部署面选档认证；档位明示于实现的兼容性声明中。

## 13. 状态算子契约（Stateful Operators，ADR-021 · 1.7.0）

有状态工具（窗口计数/去重等）的时间档位、保真披露、幂等纪律与命名立法。
规范上位档：ADR-021；消费面立法：verdict-005（trailing 语义/RateStore 实现族/
回放策略）。参考实现：contrib/rate-window.ts（1.7.0）。

### 13.1 声明字段（§3 工具声明的状态算子扩展）

| 字段       | 值域                                          | 缺省              | 语义                                                                                     |
| ---------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `temporal` | `event \| processing`                         | `event`           | `event`=asOf point-in-time 原生支持；`processing`=处理时间实现，replay 路径受 §13.2 强制 |
| `stateful` | boolean                                       | `false`           | `true`=非幂等（INCR 形态，同参重试双计）——宿主 HTTP/重试包装器 MUST 执行禁自动重试       |
| `fidelity` | `exact-per-event \| bucketed \| interpolated` | `exact-per-event` | 保真披露：进 trace 与目录（§13.4）；跨实现等价性判定的 ε 口径依据                        |

- **声明层级（OQ1 裁定）**：pack 级缺省（pack meta）+ tool 级覆盖；tool 声明
  `undefined` = 透传不冻结缺省，解析统一在注册面 schema 归一；
- **幂等键单源**：有状态调用的幂等键 = `ExecContext.requestId` 贯穿（与 ADR-002
  构造期捕获同构）；tool 级参数覆盖不做（防双键并行去重漂移）。

### 13.2 replay 路径强制（时间档位运行时）

`ExecContext.replay.asOf` 存在且工具 `temporal: 'processing'` 时，按端口
`replayPolicy` 执行：

| 策略               | 行为                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `strict`           | 结构化错误 `RATE_NO_EVENT_TIME`（入 trace 与 outcome，fail visible） |
| `degraded`（缺省） | 照常执行（处理时间回退）+ trace `TEMPORAL_FALLBACK` 标注             |

- `observe`/`act` 语义工具走 journal 读回（不重执行），**不受此强制**——与回放
  钉扎（1.5.0）同通道：journal/observed 携 packVersion，本条携时间档位强制；
- `RATE_NO_EVENT_TIME` 为 normative 错误码（§5.4 表收录）。

### 13.3 Conformance 分档（rate-store 存储实现许可）

rate-store-conformance 套件按 `mode` 分档；实现按通过档位获部署许可：

| 档                  | 向量                                                                                                                                                | 许可        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `exact`             | 现套件全向量（含 asOf point-in-time）+ **重试双计向量**：rate INCR 形态同参重试 MUST 双计；groupDistinct 的 pv 双计而 uv 不双计——「非幂等」钉进契约 | live-only   |
| `approximate`       | exact 向量 − 重试双计 + ε 容差 + 单调性豁免声明                                                                                                     | live-only   |
| exact + asOf 全通过 | —                                                                                                                                                   | live+replay |

与 §12 一致性档位正交：§12 认**语言实现**，本节认 **rate-store 存储实现**。

### 13.4 命名通式与禁用词

- 通式：**`trailing_<agg>_<window>`**——`trailing` = 右缘锚定当前请求时刻、向回
  看 window（逐请求重算，事件老化）。现注册：`trailing_count_1h`、
  `trailing_distinct_1h`（namespace `trailing-window`）；
- **`rolling` 禁用**：Flink 语境 = tumbling（固定网格互不重叠、与请求时刻无关），
  pandas/图表语境 = 移动平均——两圈子语义相反，禁用消除歧义；
- **双名过渡**：改名 = 新名注册 + 旧名 alias 同 run 函数 + `deprecated` 元数据
  （since 1.7.0）——存量图按名解析永久可读（ADR-015 双读先例）；退役按 ADR-009
  治理，过渡期长度按存量图旧名引用盘点定档；
- 结果侧 ε 载体：`VelocityProvenance.relErrorBound`（宿主 velocity 契约）——
  目录静态声明（本节 `fidelity`）与结果动态自证两层对齐；不一致以结果为准并告警。
