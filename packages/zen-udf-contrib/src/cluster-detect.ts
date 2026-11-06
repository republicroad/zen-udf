// 聚集检测参考域：同源聚集监测（一机多号 / 一号多机 / 枚举扫描的通用形态）。
// group 下 value 的窗口聚集（uv 首见 / pv 出现 / gpv 组事件）+ 三级 idle（gidle/vidle）
// + ttl（距滑出）。delta pv/uv 即最近窗口的 pv/uv（导数即近似积分，双桶重合）。
// 黑产只要时间空间聚集，立即被捕获（时间维=uv 增速/idle 骤变；空间维=度数骤增）。
import { tool } from "@republicroad/zen-udf";
import { Type } from "@sinclair/typebox";

import { HaProxyCountNode } from "./haproxy-nodes.ts";

export const createClusterDetectTool = (node: HaProxyCountNode) =>
  tool({
    namespace: "cluster-detect",
    name: "cluster_probe",
    description:
      "聚集检测：同源下不同个体的窗口聚集计数（一机多号 / 一号多机的通用形态）。" +
      "uv=窗口内首见不同值数（插值）、pv=该 (组,值) 对出现数、gpv=组事件数、" +
      "gidle/vidle=组/值上次出现间隔、ttl=距滑出。双向判读：换 group/value 参数即换向。",
    semantics: "observe",
    temporal: "processing",
    stateful: true,
    fidelity: "interpolated",
    input: Type.Object({
      group: Type.String({ title: "分组键", description: "聚集主体（如 ip、设备指纹）" }),
      value: Type.String({ title: "观测值", description: "去重个体（如 phone、账号）" }),
    }),
    output: Type.Object({
      uv: Type.Integer({ title: "UV（窗口内首见不同值数）", default: 0 }),
      pv: Type.Integer({ title: "PV（该 (组,值) 对出现数）", default: 0 }),
      gpv: Type.Integer({ title: "组事件数", default: 0 }),
      gidle: Type.Integer({ title: "组 idle（秒）", default: 0 }),
      vidle: Type.Integer({ title: "值 idle（秒）", default: 0 }),
      ttl: Type.Integer({ title: "距滑出（秒）", default: 0 }),
    }),
    run: async (kwargs: { group?: unknown; value?: unknown }) => {
      const group = String(kwargs?.group ?? "");
      const value = String(kwargs?.value ?? "");
      const row = await node.clusterProbe(group, value);
      return { uv: row.uv, pv: row.pv, gpv: row.gpv, gidle: row.gidle, vidle: row.vidle, ttl: row.ttl };
    },
  });
