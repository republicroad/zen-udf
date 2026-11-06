// 近似滑窗计数参考域：当前请求的滑动窗口计数（单计数器，双桶插值）。
// counter 即 delta（导数≈窗口累计，双桶重合）；ttl=距滑出；idle=距上次事件。
import { tool } from "@republicroad/zen-udf";
import { Type } from "@sinclair/typebox";

import { HaProxyCountNode } from "./haproxy-nodes.ts";

export const createApproxCountTool = (node: HaProxyCountNode) =>
  tool({
    namespace: "trailing-approx",
    name: "approx_trailing_count",
    description:
      "近似滑窗计数（HAProxy 双桶插值）：记录实体事件并返回窗口内事件计数（counter 即 delta）。" +
      "处理时间语义、插值保真——高频实时信号专用，审计级精确请使用 velocity 域。",
    semantics: "observe",
    temporal: "processing",
    stateful: true,
    fidelity: "interpolated",
    input: Type.Object({
      entity: Type.String({ title: "实体", description: "计数实体（如 ip、phone）" }),
      kind: Type.String({ title: "事件类型", description: "kind 进键消塌缩（缺省空串）", default: "" }),
    }),
    output: Type.Object({
      counter: Type.Integer({ title: "窗口计数", default: 0 }),
      idle: Type.Integer({ title: "idle（秒）", default: 0 }),
      ttl: Type.Integer({ title: "距滑出（秒）", default: 0 }),
    }),
    run: async (kwargs: { entity?: unknown; kind?: unknown }) => {
      const kind = String(kwargs?.kind ?? "");
      const entity = String(kwargs?.entity ?? "");
      const row = await node.approxCount(kind ? `${kind}:${entity}` : entity);
      return { counter: row.counter, idle: row.idle, ttl: row.ttl };
    },
  });
