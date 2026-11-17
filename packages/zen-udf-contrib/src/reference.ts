// 参考函数域装载（builtin: 'reference' 的实现核心）。
// import 本模块即向 globalUdfRegistry 注册全部 contrib 工具（各 contrib 模块的
// 模块级副作用：旧域经 defineContrib、新域（tool()/pack()）经模块内显式
// globalUdfRegistry.register）；需要装载到独立实例（多租户/多运行时隔离）时，
// 调用 loadReferenceInto(registry)。业务 UDF 包（verdict 侧）不应依赖本模块。
//
// ADR-011 尾项完成：全部域已收敛为单轨（tool()/pack() 唯一风格）。
// 批次 168（三包架构）：有状态域（trailing-window/value_list/custom-list-query）
// 及 haproxy 三件/dedup-hll 已迁企业包 zen-udf-ee——本包只留无状态 11 域。
import abBucketPack from "./contrib/ab-bucket.ts";
import cryptoPack from "./contrib/crypto.ts";
import datetimePack from "./contrib/datetime.ts";
import debugPack from "./contrib/debug.ts";
import debuguiPack from "./contrib/debugui.ts";
import geoPack from "./contrib/geo.ts";
import ipLocationPack from "./contrib/ip-location.ts";
import templatePack from "./contrib/template.ts";
import validatePack from "./contrib/validate-cn.ts";
import { globalUdfRegistry, type UdfRegistry } from "@republicroad/zen-udf";
import type { UdfTool } from "@republicroad/zen-udf";

/** 新风格域清单（tool()/pack()）：装载走 register 唯一入口（ADR-011 单轨收敛） */
export interface ReferencePack {
  id: string;
  tools: UdfTool<any, any>[];
}

export const referencePacks: ReferencePack[] = [
  { id: "ab-bucket", tools: abBucketPack.tools },
  { id: "dt", tools: datetimePack.tools },
  { id: "crypto", tools: cryptoPack.tools },
  { id: "debug", tools: debugPack.tools },
  { id: "debugui", tools: debuguiPack.tools },
  { id: "geo", tools: geoPack.tools },
  { id: "ip-location", tools: ipLocationPack.tools },
  { id: "template", tools: templatePack.tools },
  { id: "validate", tools: validatePack.tools },
];

/**
 * 参考域元数据（ADR-009）：origin=reference；version 随 zen-udf 发版同步更新
 * （与 package.json 一致，目录据此做过期提示）。
 */
export const REFERENCE_PACK_META = { origin: "reference" as const, version: "3.0.0" };

/** 将参考函数域注册到任意注册表（实例隔离场景用；global 的注册由 import 副作用完成） */
export const loadReferenceInto = (registry: UdfRegistry): void => {
  for (const pack of referencePacks) {
    registry.register({ id: pack.id, tools: pack.tools });
    registry.setPackMeta(pack.id, REFERENCE_PACK_META);
  }
};

// globalUdfRegistry 的参考域同样打标记（import 副作用注册路径的 meta 补录）
for (const pack of referencePacks) {
  globalUdfRegistry.setPackMeta(pack.id, REFERENCE_PACK_META);
}

