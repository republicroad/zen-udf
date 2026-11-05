import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";




/**
 * 旧平台函数域重建（第六十九批 D2，docs/13 §8.3）：IP 属地解析。
 * 数据集**不捆绑**——通过 env `IP_LOCATION_DATASET` 指向 JSON 文件（结构：
 * `{ "<ip前缀>": { "country": "..", "province": "..", "city": "..", "isp": ".." }, ... }`，
 * 最长前缀匹配）。未配置/未命中时返回空字段 + ip 回显（图内 returnSchema 的
 * required 字段齐全，仿真链路可跑通）。
 */

interface GeoEntry {
  country?: string;
  province?: string;
  city?: string;
  isp?: string;
}

let cachedPath: string | undefined;
let cachedDataset: Record<string, GeoEntry> | undefined;

const loadDataset = (): Record<string, GeoEntry> => {
  const p = process.env.IP_LOCATION_DATASET;
  if (!p) return {};
  if (cachedPath === p && cachedDataset) return cachedDataset;
  try {
    cachedDataset = JSON.parse(readFileSync(p, "utf8")) as Record<string, GeoEntry>;
    cachedPath = p;
  } catch (error) {
    console.warn("[ip_location] 数据集加载失败，按未配置处理:", error instanceof Error ? error.message : error);
    cachedDataset = {};
    cachedPath = p;
  }
  return cachedDataset;
};

export const ipLocationTool = tool({
  namespace: "ip-location",
  name: "ip_location",
  description:
    "旧域重建·IP 属地解析：按最长前缀匹配数据集（env IP_LOCATION_DATASET 指向 JSON）返回 country/province/city/isp；未命中返回空字段。",
  semantics: "query",
  input: Type.Object({
    ip: Type.String({ title: "IP", description: "待解析的 IP 地址" }),
  }),
  output: Type.Object({
    country: Type.String({ title: "Country" }),
    province: Type.String({ title: "Province" }),
    city: Type.String({ title: "City" }),
    isp: Type.String({ title: "Isp" }),
    ip: Type.String({ title: "Ip" }),
  }),
  run: (input) => {
    const ip = String(input?.ip ?? "");
    const dataset = loadDataset();
    const hit = Object.keys(dataset)
      .filter((prefix) => ip.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const geo = hit ? dataset[hit] : undefined;
    return {
      country: geo?.country ?? "",
      province: geo?.province ?? "",
      city: geo?.city ?? "",
      isp: geo?.isp ?? "",
      ip,
    };
  },
});

export default pack({ id: "ip-location", tools: [ipLocationTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "ip-location", tools: [ipLocationTool] }));
