# zen-udf 命名规范与重命名记录

本文档是包内命名的事实来源（source of truth）：现行名称、语义依据、以及 2026-09 重命名的完整映射。在 git 历史、旧文档或跨仓讨论中遇到旧名时，按第二节映射表理解。

## 现行命名

| 名称 | 类型 | 位置 | 职责 |
| --- | --- | --- | --- |
| `DecisionRuntime` | class | `src/engine.ts` | 决策图运行时：包装 `ZenEngine`、按 key 版本化决策缓存（create/update/delete/getDecisionWithCacheKey）、graphAddons 图增强、`evaluate`/`evaluateAsync` 门面 |
| `UdfRegistry` | class | `src/register.ts` | UDF 注册表：函数注册/查找、位置参数→kwargs 绑定（`funcBindParams`）、调用、JSON Schema 下发（编辑器侧边栏契约） |
| `globalUdfRegistry` | singleton | `src/register.ts` | 全局默认注册表实例（U3 实例注入落地前的静态默认） |

## 2026-09 重命名映射

本次重命名落地于 commit `20f529e2`（同日宿主确认命名裁决）。

| 旧名 | 新名 | 说明 |
| --- | --- | --- |
| `class ZenRule` | `class DecisionRuntime` | 主运行时类 |
| `class UDFManager` | `class UdfRegistry` | 函数注册表类 |
| 单例导出 `udfManager` | `globalUdfRegistry` | 全局默认实例 |
| 静态字段 `ZenRule.udfManager` | `DecisionRuntime.registry` | U3 实例注入时此静态绑定将移除，改为实例字段 |

## 为什么改名

**`ZenRule` → `DecisionRuntime`**："Rule" 指向它执行的产物（规则图），不是它自身的职责；"Engine" 不可用（底层是 `ZenEngine`，zen-engine Rust 核心同名类为 `DecisionEngine`，套娃命名会造成灾难）。业界对"长生命周期对象：持有编译产物缓存 + 执行 + 生命周期钩子"的标准词是 **Runtime**（GraphQL runtime、Temporal runtime）。`DecisionRuntime` 在 verdict 的 model-execute 语境中读作"决策运行时"，自解释。

**`UDFManager` → `UdfRegistry`**："Manager" 是命名反模式（说不清管理什么、怎么管理）。该类实际职责是注册表三合一：**注册 + 查找 + 调用**，外加参数绑定与 schema 下发。业界同场景（MCP/OpenAI tool registry、Fastify decorator registry、GraphQL resolver registry）的标准词是 **Registry**。

## 刻意不改的部分

以下名称保持不动，API 面的进一步演进（`UdfPack` 契约等）统一留给 U6 定形，避免两次破坏：

- 函数级注册 API：`registerUdf` / `createExtRegister` / `defineContrib` / `defineTool`
- 方法名：`registerFunction` / `udfFunctionSchema` / `funcBindParams` / `call` / `udfFunctionSchemaTools` / `udfFunctionSchemaNamespaces`
- contrib 参考域文件名即 namespace 的约定

## 兼容性说明

改名落地时（commit `20f529e2`）包为 0.1.x private、**无任何外部消费者**，因此采取硬改、不设废弃别名。0.2.0（U6 后，发布 npm 公开仓）首发即新名。verdict 及后续消费方直接使用现行命名即可。
