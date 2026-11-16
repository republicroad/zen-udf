# @republicroad/zen-udf-contrib

zen-udf 官方【无状态】参考域集合（2.0.0 起三包架构定界）：crypto、datetime（dt）、
template、validate（id_card/mobile/uscc/bank_card）、geo（distance/fence）、ab-bucket、
http（http_request，egress 门控 + maxBytes 守卫）、notify（webhook）、ip-location、debug/debugui
——**11 域**，纯计算或单次出站调用，不持任何服务端状态。

有状态域（haproxy 三件/trailing-window 频次族/value_list+custom-list-query 名单/
dedup-hll）已迁企业包 zen-udf-ee（批次 168 三包架构）。

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
