/**
 * value_list 核心机制（原 roster 域，ADR verdict-009 D2 提案改名——2026-10-29 起
 * 双名过渡：value_list 为唯一正名，roster 系命名 @deprecated 保留一个过渡期后按
 * ADR-009 治理退役。roster 英文语义=人员名册，名单资产承载 email/设备号/订单号
 * 等值集合，业界伞词 = value list（Stripe radar.value_lists / Elastic Security /
 * Cloudflare Lists）。）
 *
 * 名单作用域（U5 租户化）：tenantId 必填；actor 缺省 = 租户共享，指定 actor = 该
 * 用户私有。可见性：自有 > 租户共享 > 不可见他人；无 actor（管理员）遍历本租户
 * 全域。跨租户永不可见。
 */

export interface ValueList {
  name: string;
  description?: string;
  /** 名单条目——注册时物化为 Set（查询走 O(1) 命中；注册后改本数组不生效=注册快照语义） */
  items: string[];
  /** 版本化资产标注（可选，ADR verdict-009 D7）：原子换版的版本号，queryValueList 随命中结果透传（list@version provenance） */
  version?: number;
}

/** @deprecated ADR verdict-009 D2 改名 → ValueList（过渡期别名，随 roster 系命名退役） */
export type Roster = ValueList;

export interface ValueListScope {
  tenantId: string;
  actor?: string;
}

/** @deprecated ADR verdict-009 D2 改名 → ValueListScope */
export type RosterScope = ValueListScope;

interface TenantStore {
  /** 租户共享名单 */
  shared: Map<string, ValueListEntry>;
  /** actor → name → value list（用户私有名单） */
  private: Map<string, Map<string, ValueListEntry>>;
}

/** 注册时物化：条目副本 + Set 索引（String 同构——查询值/条目均按 String 归一比对） */
interface ValueListEntry {
  valueList: ValueList;
  index: Set<string>;
}

const tenants = new Map<string, TenantStore>();

const tenantOf = (tenantId: string): TenantStore => {
  let store = tenants.get(tenantId);
  if (!store) {
    store = { shared: new Map(), private: new Map() };
    tenants.set(tenantId, store);
  }
  return store;
};

interface ResolvedEntry {
  entry: ValueListEntry;
  /** 私有名单命中时的属主 actor；共享名单无属主 */
  ownerActor?: string;
}

const resolveValueListEntry = (name: string, scope: ValueListScope): ResolvedEntry | null => {
  const tenant = tenants.get(scope.tenantId);
  if (!tenant) return null;
  if (scope.actor) {
    const own = tenant.private.get(scope.actor)?.get(name);
    if (own) return { entry: own, ownerActor: scope.actor };
    const shared = tenant.shared.get(name);
    if (shared) return { entry: shared };
    return null;
  }
  // 管理员（无 actor）：租户共享优先，其次遍历本租户私有域
  const shared = tenant.shared.get(name);
  if (shared) return { entry: shared };
  for (const [actor, map] of tenant.private) {
    const hit = map.get(name);
    if (hit) return { entry: hit, ownerActor: actor };
  }
  return null;
};

const assertScope = (scope: ValueListScope): void => {
  if (!scope?.tenantId) {
    throw new Error("[value_list] scope.tenantId is required");
  }
};

export const registerValueList = (valueList: ValueList, scope: ValueListScope): void => {
  assertScope(scope);
  const tenant = tenantOf(scope.tenantId);
  // 注册时物化（快照语义）：条目副本 + Set 索引——注册后改 items 数组不生效
  const stored: ValueListEntry = {
    valueList: { ...valueList, items: [...valueList.items] },
    index: new Set(valueList.items.map((item) => String(item))),
  };
  if (scope.actor) {
    let own = tenant.private.get(scope.actor);
    if (!own) {
      own = new Map();
      tenant.private.set(scope.actor, own);
    }
    own.set(stored.valueList.name, stored);
  } else {
    tenant.shared.set(stored.valueList.name, stored);
  }
};

/** 解析 actor 可访问的名单：有 actor 时自有优先、租户共享次之、他人私有不可见；无 actor（管理员）共享优先、遍历本租户私有域 */
export const getValueList = (name: string, scope: ValueListScope): ValueList | undefined => {
  assertScope(scope);
  return resolveValueListEntry(name, scope)?.entry.valueList;
};

export const listValueLists = (query: string | undefined, scope: ValueListScope): ValueList[] => {
  assertScope(scope);
  const tenant = tenants.get(scope.tenantId);
  if (!tenant) return [];
  const collected: ValueList[] = [];
  if (scope.actor) {
    collected.push(...[...(tenant.private.get(scope.actor)?.values() ?? [])].map((e) => e.valueList));
    collected.push(...[...tenant.shared.values()].map((e) => e.valueList));
  } else {
    collected.push(...[...tenant.shared.values()].map((e) => e.valueList));
    for (const map of tenant.private.values()) collected.push(...[...map.values()].map((e) => e.valueList));
  }
  const q = query?.trim().toLowerCase() ?? "";
  const visible = q ? collected.filter((list) => list.name.toLowerCase().includes(q)) : collected;
  return visible.map((entry) => ({ ...entry }));
};

export const deleteValueList = (name: string, scope: ValueListScope): boolean => {
  assertScope(scope);
  const resolved = resolveValueListEntry(name, scope);
  if (!resolved) return false;
  if (resolved.ownerActor !== undefined && scope.actor !== undefined && scope.actor !== resolved.ownerActor) {
    return false;
  }
  const tenant = tenants.get(scope.tenantId)!;
  if (resolved.ownerActor !== undefined) {
    return tenant.private.get(resolved.ownerActor)?.delete(name) ?? false;
  }
  return tenant.shared.delete(name);
};

export const queryValueList = (
  name: string,
  value: unknown,
  scope: ValueListScope,
): { hit: boolean; list: string; value: unknown; version?: number } => {
  assertScope(scope);
  const resolved = resolveValueListEntry(name, scope)?.entry;
  const hit = resolved ? resolved.index.has(String(value)) : false;
  return {
    hit,
    list: resolved?.valueList.name ?? name,
    value,
    ...(resolved?.valueList.version !== undefined ? { version: resolved.valueList.version } : {}),
  };
};

/** @deprecated ADR verdict-009 D2 改名 → registerValueList（结果/物化语义见 value-list.ts 头注） */
export const registerRoster = registerValueList;
/** @deprecated ADR verdict-009 D2 改名 → getValueList */
export const getRoster = getValueList;
/** @deprecated ADR verdict-009 D2 改名 → listValueLists */
export const listRosters = listValueLists;
/** @deprecated ADR verdict-009 D2 改名 → deleteValueList */
export const deleteRoster = deleteValueList;
/** @deprecated ADR verdict-009 D2 改名 → queryValueList（结果字段 roster→list，version 透传新增） */
export const queryRoster = queryValueList;
