// 参考域聚合入口：根导入即向 globalUdfRegistry 注册全部参考域
// （各域模块级副作用）。需要空注册表（实例隔离）时 new UdfRegistry() +
// loadReferenceInto(registry) 按需装载。
import "./reference.ts";

export { loadReferenceInto, referencePacks } from "./reference.ts";
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
