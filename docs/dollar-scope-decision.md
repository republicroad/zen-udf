# 决策文档：`$` 解析机制与作用域边界（dt 单元格 / 表达式节点 / kwargs）

- 日期：2026-10-04
- 状态：**立法（legislative）**——机制出处为 zen 仓源码实证（Rust 行号级）；
  宿主语义描述已实证对账；dt 侧 2×2×2 全矩阵实证补全（§2.1，八态全绿）
- 关联：CONTRACT.md §11（调用形态）、§11.5（实例依赖调度）、§11.6（TypedValue
  信封）、ADR-016 OQ7（seal 仓对账档）

## 1 · 机制：`$` 是 isolate 的 dollar 局部变量

zen-expression 的求值 isolate 维护一个 `$` 局部变量，两个写入口：

| 写入口 | 语义 | 源码 |
| --- | --- | --- |
| `insert_dollar(path, value)` | 向 `$` 对象 dot_insert 键值 | `core/expression/src/isolate.rs:80` |
| `set_reference_value(value)` | 整体换绑 `$` 到某对象 | `isolate.rs:108` |

谁调用它们，`$` 就指向谁——**`$` 的语义是求值器状态机，不是全局常量**。

## 2 · 三面作用域边界（实证 + 源码出处）

| 面 | `$` 绑定 | `$.fieldx` 语义 | 源码出处 |
| --- | --- | --- | --- |
| **表达式节点** | 每行求值后 `insert_dollar(key, output)`——前行输出累积 | 前行输出 fieldx（`$.a+$.b` 行内顺序引用） | `core/engine/src/nodes/expression/mod.rs:51` |
| **决策表单元格（列已设 field）** | `set_reference(field)`——`$` 换绑为列 field 对象 | 列 field 对象下的 fieldx（如 field=cart → `$.fieldx`=cart.fieldx） | `core/engine/src/nodes/decision_table/mod.rs:335-338`（`row_matches`：`set_reference(field)` + `run_unary`） |
| **决策表单元格（列未设 field）** | 无换绑——单元格表达式对整行输入直接 `run_standard` | `$` 无绑定/承前状态；**裸键 `fieldx` = 输入根 fieldx**（推荐写法） | `mod.rs:338-341`（`None => run_standard(rule_value)`） |
| **自定义节点 kwargs** | **从未接通 dollar 作用域**（standalone 绑定无 insert/set_reference 调用） | `$.fieldx` 恒 null——字段引用用裸键/点路径或 reference 信封 | 本仓 `engine.ts` 具名分支（evaluateExpressionSync 直评） |

### 2.1 · dt 侧全矩阵实证（2×2×2，DecisionRuntime 全图探针，八态全绿）

两个二值维度：**列是否设 field** × **引用写法**（`$.fieldx` / 裸键 `fieldx`）×
**单元格面**（条件 / 输出映射）。输入根恒带同名 `fieldx` 以分辨命名空间归属：

| 列 field | 写法 | 条件侧 | 输出映射侧 | 判读 |
| --- | --- | --- | --- | --- |
| 已设（cart） | `$.fieldx` | `=='X'` 命中 | → `cart.fieldx`（X，根同名值不干扰） | `$` = 列 field 对象 |
| 已设（cart） | 裸键 `fieldx` | `=='ROOTKEY'` 命中 | → 根 `fieldx`（ROOTKEY） | **裸键恒 = 入参命名空间** |
| 未设 | `$.fieldx` | — | **缺 `out` 键**（失败缺省，非报错非误值） | `$` 无绑定 → 单元格求值失败 → 输出键缺省 |
| 未设 | 裸键 `fieldx` | `=='ROOT'` 命中 | → 根 `fieldx`（ROOT，**推荐写法**） | 裸键 = 输入根 |

- 立法测试：`src/dt-dollar-scope.test.ts`（七用例，走 DecisionRuntime 全图）；
- **新钉死的三条立法级事实**：①输出映射与条件单元格**同规**（双命名空间
  不分面）；②列已设时裸键仍指输入根而非列对象（`$` 与裸键是两个独立
  解析通道，`set_reference` 只动 `$`）；③`$` 无绑定的失败形态=**输出键
  缺省**（zen dt 节点对单元格求值失败静默缺省，不中断不误值）。

## 3 · 裁定

1. **dt 单元格与表达式节点的 `$.` 语义为 zen-engine 原生行为**（wasm 求值器
   内建，kernel 无预处理）——CONTRACT dt 求值域以此为准；实证：表达式节点
   `{a,b,c:$.a+$.b→3}`、dt 侧 2×2×2 全矩阵八态（§2.1，宿主编辑器模拟器截图
   + 本仓 DecisionRuntime 全图探针/立法测试）；
2. **kwargs 侧维持不接通**（ADR-016 OQ7 裁定维持）：字段引用用裸键/点路径或
   reference 信封；接通需在 standalone 入口接 dollar 作用域，与 0.15 替换器/
   ADR-016 信封识别三面交叠，收益不抵风险；
3. **dt 列未设 field 的分支**：裸键 = 输入根（入参命名空间）为推荐写法；
   `$` 承前语义依赖执行顺序，不建议依赖。

## 4 · 差异根源备查

表达式节点/kwargs 同为「字符串表达式求值」，行为却不同——因为求值入口不同：
表达式节点走引擎 isolate（dollar 作用域已接通），kwargs 实参走 standalone
绑定（`evaluateExpressionSync`，无 dollar 接通）。**同一表达式语法，三种
isolate 状态 = 三种语义**——这是 `$` 作用域边界表的机制本质。

## 5 · 两轮实证记录（测试纪律立法）

**第一轮（2026-10-04 上午，两处误判叠加 → dt 侧"语义不通"假象）**：

1. **裸 ZenEngine 视角误判**（OQ7 前次误判根源）：裸引擎求 dt 图缺 kernel
   侧预处理，会得出错误结论——**dt 语义测试必须走 DecisionRuntime 全图**；
2. **规则键误用 field 名**：dt 探针把规则输出值挂在 `out`（输出列 field 名）
   键上，而 zen-engine 决策表序列化契约是**rules 按列 id 取值**（inputs/
   outputs 列各有 `id`+`field`，rules 对象的键=id；`field` 只是输出映射的
   结果字段名）→ 恒缺 `out`，被误读为 `$.fieldx` 在 dt 侧不通，测试 skip 挂起。

**第二轮（定位轮）**：规则键改列 id 后全图探针八态全绿（§2.1），与立法边界
表逐一吻合——前轮"dt 侧不通"系测试图构造错误，非语义分歧。

**设计要点（测试/集成写图三条纪律）**：

1. rules 键=列 id（序列化契约）——宿主集成与测试写图最易踩的静默失配点
   （失配形态=输出键缺省，无报错）；
2. dt 语义测试必须走 DecisionRuntime 全图（裸引擎视角不具立法资格）；
3. 双命名空间是一条规则的两面：**裸键恒=输入根；`$`=当前绑定**（列已设→
   列对象；未设→无绑定失败缺省）——条件侧与输出侧同规，勿分面记忆。

## 6 · 维护

- zen-engine 升级后如 `$` 语义变化（如 standalone 接通 dollar），须重跑
  `adr015-inline-schedule.test.ts` 的 `$.fieldx` 用例与 `dt-dollar-scope.test.ts`
  七用例（已恢复，走 DecisionRuntime 全图路径）并更新本文档；
- 多语言移植版 MUST 在对应面复现同一边界（表达式节点/单元格 `$` 可用、
  kwargs `$` 恒 null 或显式报错），并入 §7 conformance 档位验收。
