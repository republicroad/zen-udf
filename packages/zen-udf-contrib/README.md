# @republicroad/zen-udf-contrib

zen-udf 官方参考域集合：velocity 频次族（record/stats/ratio）、名单 `list_match`、
`http_request`（egress 门控 + maxBytes 守卫）、intl-phone（E.164/归属地/运营商）、IP 族
（canonical/private/cidr）、identity（email）、notify、crypto、ab-bucket、datetime、geo、
debug、validate-cn 等 **21 域 54 工具**。

依赖 [@republicroad/zen-udf](https://www.npmjs.com/package/@republicroad/zen-udf)（核心运行时），
装载方式二选一：

```ts
import "@republicroad/zen-udf-contrib";                              // 根导入自动装载 globalUdfRegistry
// 或实例隔离：
import { UdfRegistry } from "@republicroad/zen-udf";
import { loadReferenceInto } from "@republicroad/zen-udf-contrib";
const registry = new UdfRegistry();
loadReferenceInto(registry);
```

各域 schema 与语义轴（query/observe/act）见包内 `src/` 与上游 CONTRACT.md。

MIT License
