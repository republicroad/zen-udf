// 参考域聚合入口：根导入即向 globalUdfRegistry 注册全部参考域
// （各域模块级副作用）。需要空注册表（实例隔离）时 new UdfRegistry() +
// loadReferenceInto(registry) 按需装载。
import "./reference.ts";

export { loadReferenceInto, referencePacks } from "./reference.ts";
// HAProxy 计数节点三专用工具（聚集检测 / 近似滑窗计数 / A:B 计分板）：
// 组合根 new HaProxyCountNode({ baseUrl }) 后经 createXxx(node) 工厂构造并注册
export { HaProxyCountNode, type HaNodeOptions, type ScoreboardSlot } from "./haproxy-nodes.ts";
export { createClusterDetectTool } from "./cluster-detect.ts";
export { createApproxCountTool } from "./approx-count.ts";
export { createScoreboardTool, type ScoreboardToolOptions } from "./scoreboard.ts";
export { InMemoryDedupHllStore, type DedupHllStore, type DedupHllToolOptions } from "./dedup-hll.ts";
export { createDedupHllTools } from "./dedup-hll.ts";
export { Hll } from "./hll.ts";
export { type ReferencePack } from "./reference.ts";
export {
  deleteRoster,
  deleteValueList,
  getRoster,
  getValueList,
  listRosters,
  listValueLists,
  queryRoster,
  queryValueList,
  registerRoster,
  registerValueList,
  type Roster,
  type RosterScope,
  type ValueList,
  type ValueListScope,
} from "./value-list.ts";
export { trailingCount1hTool, trailingDistinct1hTool } from "./trailing-window.ts";
