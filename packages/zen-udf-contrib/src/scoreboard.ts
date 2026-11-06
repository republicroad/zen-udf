// scoreboard 参考域：A:B 双谓词分类计数（两队竞技计分语义）。
// 谓词在引擎表达式求值器求值出布尔（$call kwargs 求值后传值），fn 按真假路由
// 槽位：A 真→incr 槽 A；B 真→incr 槽 B；双真→双槽各 +1；双假→纯读不建键
// （GET 纯读化立法的键污染防护）。比值带分母守卫（velocity_ratio 同款）。
//
// fidelity = interpolated（HAProxy 双桶插值）；temporal = processing。
import { tool } from "@republicroad/zen-udf";
import { Type } from "@sinclair/typebox";

import { HaProxyCountNode, type ScoreboardSlot } from "./haproxy-nodes.ts";

export interface ScoreboardToolOptions {
  /** ratio 分母守卫：b < floor 时 ratio = null（velocity_ratio 同款，缺省 3） */
  ratioFloor?: number;
}

export const createScoreboardTool = (node: HaProxyCountNode, opts: ScoreboardToolOptions = {}) =>
  tool({
    namespace: "scoreboard",
    name: "scoreboard_tally",
    description:
      "A:B 计分板：同窗双谓词分类计数（两队竞技计分语义）。" +
      "谓词在图内对节点输入求值，真值决定计分槽位（双真双计，漏斗多级兼容）；" +
      "返回双方窗口计数与比值（分母守卫）。",
    semantics: "observe",
    temporal: "processing",
    stateful: true,
    fidelity: "interpolated",
    input: Type.Object({
      entity: Type.String({ title: "实体", description: "计分主体（如 ip、accountId）" }),
      incA: Type.Boolean({ title: "计入 A 队", description: "谓词求值为真则 A 计数 +1" }),
      incB: Type.Boolean({ title: "计入 B 队", description: "谓词求值为真则 B 计数 +1" }),
    }),
    output: Type.Object({
      a: Type.Integer({ title: "A 队窗口计数" }),
      b: Type.Integer({ title: "B 队窗口计数" }),
      ratio: Type.Union([Type.Number(), Type.Null()], { title: "A/B 比值（分母不足为 null）" }),
    }),
    run: async (kwargs: { entity?: unknown; incA?: unknown; incB?: unknown }) => {
      const entity = String(kwargs?.entity ?? "");
      const slot: ScoreboardSlot =
        kwargs?.incA === true && kwargs?.incB === true
          ? "AB"
          : kwargs?.incA === true
            ? "A"
            : kwargs?.incB === true
              ? "B"
              : "NONE";
      const { a, b } = await node.scoreboardTally(entity, slot);
      const floor = opts.ratioFloor ?? 3;
      const ratio = b >= floor ? a / b : null;
      return { a, b, ratio };
    },
  });
