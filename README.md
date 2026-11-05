# zen-udf

[zen-engine](https://www.npmjs.com/package/@republicroad/zen-engine) 自定义节点 UDF 运行时——多函数执行 spec、
UdfPack 注册表、L1 决策缓存、多租户执行上下文、数据面端口与参考域。

## 包家族

| 包 | 内容 | npm |
|---|---|---|
| [`@republicroad/zen-udf`](./packages/zen-udf) | 核心运行时：引擎适配 / 注册表 / L1 缓存 / ExecContext / 端口 / 断路器 / Conformance 框架 | [`@republicroad/zen-udf`](https://www.npmjs.com/package/@republicroad/zen-udf) |
| [`@republicroad/zen-udf-contrib`](./packages/zen-udf-contrib) | 官方参考域：velocity 频次、名单、http、intl-phone、IP、identity 等 21 域 54 工具 | [`@republicroad/zen-udf-contrib`](https://www.npmjs.com/package/@republicroad/zen-udf-contrib) |
| `@republicroad/zen-udf-ee`（私有仓） | 企业层：行业算子与数据 | 私有分发 |

引擎：[@republicroad/zen-engine](https://www.npmjs.com/package/@republicroad/zen-engine)（MIT）——zen 引擎分支，带 execution context。
Python 版 zen-udf 规划中（`python/`，同语义契约）。

## 仓库结构

```
packages/zen-udf/           # 核心运行时（MIT）
packages/zen-udf-contrib/   # 官方参考域（MIT）
python/                     # Python 版（规划中）
conformance/                # 跨语言语义契约 fixtures（规划中）
CONTRACT.md                 # UDF 契约单一语义源
```

## 快速上手

```bash
npm i @republicroad/zen-udf @republicroad/zen-udf-contrib @republicroad/zen-engine
```

运行时：Bun（主场景）；Node.js ≥ 23.6 原生跑 TS。包以 TypeScript 源码形态发布（刻意设计，详见各包 README）。

```ts
import { setPorts, globalUdfRegistry } from "@republicroad/zen-udf";
import { loadReferenceInto } from "@republicroad/zen-udf-contrib";

// 参考域显式装载（或 import "@republicroad/zen-udf-contrib" 根副作用自动装载）
loadReferenceInto(globalUdfRegistry);
setPorts({ egressGuard, secretResolver });
```

契约全貌见 [CONTRACT.md](./CONTRACT.md)。

## License

MIT（zen-udf-ee 私有仓除外）
