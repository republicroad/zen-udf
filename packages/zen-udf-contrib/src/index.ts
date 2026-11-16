// 参考域聚合入口：根导入即向 globalUdfRegistry 注册全部参考域
// （各域模块级副作用）。需要空注册表（实例隔离）时 new UdfRegistry() +
// loadReferenceInto(registry) 按需装载。
//
// 批次 168（三包架构）：contrib 定位收敛为【开源无状态工具包】——纯计算
// 与单次出站调用（egress/secret 端口）。有状态面（haproxy 三件/trailing-window
// /dedup-hll/value-list 存储与查询工具）已迁企业包 zen-udf-ee。
import "./reference.ts";

export { loadReferenceInto, referencePacks } from "./reference.ts";
export { type ReferencePack } from "./reference.ts";
