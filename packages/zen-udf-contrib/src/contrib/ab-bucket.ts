import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// ab 域(ab_bucket 函数)：稳定哈希分桶——A/B 实验与灰度放量的纯函数底座。
// FNV-1a 32 位：同 key 恒同桶（可重放），无状态无出网。
//
// ADR-011 示范迁移（2026-09-29）：声明层改用理想态 tool()/pack()（TypeBox
// schema-as-type + examples conformance），装载经 registry.register 唯一入口。
// abBucket 裸函数保留导出（测试与纯函数消费方签名不变）。
import { Type } from "@sinclair/typebox";




/** FNV-1a 32 位哈希（十进制无符号） */
export const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const MIN_BUCKETS = 1;
const MAX_BUCKETS = 1000;

/** 裸函数形态（kwargs 签名）：测试与纯函数消费方沿用 */
export const abBucket = (kwargs: Record<string, unknown>): number => {
  const key = String(kwargs?.key ?? "");
  const raw = Number(kwargs?.buckets);
  const buckets = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), MIN_BUCKETS), MAX_BUCKETS) : 2;
  return fnv1a(key) % buckets;
};

export const abBucketTool = tool({
  namespace: "ab-bucket",
  name: "bucket",
  title: "ab_bucket",
  description:
    "将 key 稳定哈希到 [0, buckets) 的整数桶号（FNV-1a，同 key 恒同桶，无状态无出网）。" +
    "用于 A/B 分桶、灰度放量、按标识抽查。buckets 支持 1–1000，非法值回退 2。",
  semantics: "query",
  input: Type.Object({
    key: Type.String({ title: "Key", description: "分桶键（如 userId / deviceId）" }),
    buckets: Type.Optional(
      Type.Integer({ title: "Buckets", description: `桶数(${MIN_BUCKETS}–${MAX_BUCKETS})，默认 2`, default: 2 }),
    ),
  }),
  output: Type.Integer({ title: "桶号", description: "[0, buckets) 内的整数" }),
  examples: [{ input: { key: "user-1", buckets: 2 }, output: abBucket({ key: "user-1", buckets: 2 }) }],
  run: (input) => abBucket({ key: input.key, buckets: input.buckets }),
});

export default pack({ id: "ab-bucket", tools: [abBucketTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "ab-bucket", tools: [abBucketTool] }));
