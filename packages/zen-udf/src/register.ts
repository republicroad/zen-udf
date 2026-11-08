import { asTypedValueEnvelope } from "./instances/envelope.ts";
import type { UdfPorts } from "./ports.ts";
import { setPorts } from "./runtime-ports.ts";
import type { UdfTool, UdfFidelity } from "./tool.ts";

/**
 * 完整 JSON Schema 属性(与 brdeapi.geetest.com/zen_custom_node_function.json 对齐)。
 * index signature 允许嵌套 schema(properties/items/$defs/anyOf 等)。
 */
export interface JsonSchemaProperty {
  /** JSON Schema type；联合形态（数组，如 ["string","null"]）合法——归一化派生为 'any' 透传 */
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  anyOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  $ref?: string;
  $defs?: Record<string, JsonSchemaProperty>;
  enum?: unknown[];
  format?: string;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  $ref?: string;
  $defs?: Record<string, JsonSchemaProperty>;
  [key: string]: unknown;
}

/** 扁平参数 schema(执行/绑定用，funcBindParams 依赖) */
export interface UdfSchemaParameter {
  type?: string;
  description?: string;
  default?: unknown;
}

/** 单个自定义函数(namespace/tools 格式中的 tool)，对应 createJdmNode 的 kind */
export interface CustomFunctionTool {
  name: string;
  title: string;
  type: "function";
  description?: string;
  parameters: {
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    title?: string;
    type?: "object";
  };
  returns: JsonSchema;
  namespace?: string;
  kind: string;
  semantics: UdfSemantics;
  idempotent?: boolean;
  /** 弃用标记（A4）：由 UdfSchema.deprecated 透传 */
  deprecated?: { since?: string; note?: string };
}

/** 自定义节点命名空间(namespace/tools 格式)，对应侧边栏 group */
export interface CustomNodeNamespace {
  /** 恒为 'namespace'(集合容器档；契约字段保留供未来场景) */
  type: "namespace";
  title: string;
  name: string;
  description?: string;
  tools: CustomFunctionTool[];
  /** ADR-009：pack 元数据（origin 徽标/版本/许可），经 setPackMeta 记录后随视图透传 */
  meta?: UdfPackMeta;
}

/** 算子语义三元（Y1）：query 纯读 / observe 观测累积（处理时间，回放不重执行）/ act 处置效果（回放读 journal） */
export type UdfSemantics = "query" | "observe" | "act";
const UDF_SEMANTICS: readonly UdfSemantics[] = ["query", "observe", "act"];

/** UDF 声明 schema（1.0：parametersSchema 唯一声明形态——扁平 parameters 声明已移除） */
export interface UdfSchema {
  returns?: { type?: string; description?: string };
  /** 所属 namespace：由 registerFunction/register 显式供给（不存在默认命名空间，'default' 已入保留清单） */
  namespace?: string;
  /** 完整 JSON Schema 形式的参数定义(用于 /api/custom-nodes/schema 下发) */
  parametersSchema?: {
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    title?: string;
    type?: "object";
  };
  /** 完整 JSON Schema 形式的返回值定义 */
  returnsSchema?: JsonSchema;
  description?: string;
  /** 算子语义（Y1）：缺省 'query'；决定回放模式下的执行策略 */
  semantics?: UdfSemantics;
  /** act 语义的幂等声明（Z1）：缺失时 validatePack 产生警告（不阻断），verdict 审计可见 */
  idempotent?: boolean;
  /** 时间档位（ADR-021 §1.1）：缺省 event；processing 在 replay 路径按宿主 ReplayPolicy 强制（§1.2） */
  temporal?: "event" | "processing";
  /** 有状态声明（ADR-021 §1.3）：true = 禁自动重试；幂等键 = ExecContext.requestId 单源贯穿 */
  stateful?: boolean;
  /** 保真披露（ADR-021 §1.1）：缺省 exact-per-event；进 trace 与目录 */
  fidelity?: UdfFidelity;
  /** 弃用标记（A4）：目录/补全/画布三处标黄提示；since 为弃用发生的版本 */
  deprecated?: { since?: string; note?: string; replacement?: string };
}

interface UdfEntry {
  fn: UdfFunction;
  schema: UdfSchema;
}

/**
 * 单次工具调用的执行上下文（fn 的第二参数）：租户身份 + 取消信号。
 * signal 在 kwargs.timeout 到点或上游取消时 abort——重 I/O 函数（Redis/DB/HTTP）
 * 必须把它传给底层客户端，否则超时返回后底层调用仍占着连接继续执行。
 */
export interface ToolContext {
  namespace?: string;
  name: string;
  tenantId?: string;
  userId?: string;
  requestId?: string;
  signal: AbortSignal;
  /** 绝对截止时间（epoch ms）；kwargs.timeout 缺省时为 null */
  deadlineAt: number | null;
  /** 时间档位（ADR-021）：宿主 HTTP/重试包装器据此执行 §1.3 禁重试纪律 */
  temporal?: "event" | "processing";
  stateful?: boolean;
  fidelity?: UdfFidelity;
}

/** 可注册的 UDF 函数签名(动态注册表，运行时统一以单个 kwargs 对象调用；第二参为调用上下文) */
type UdfFunction = (kwargs: Record<string, unknown>, call?: ToolContext) => unknown;

/** JSON Schema type 语义匹配（校验用；'any'/'null' 恒真，未知类型不判违例） */
function matchJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonT2pyT(jsonType: string): (v: unknown) => unknown {
  const m: Record<string, (v: unknown) => unknown> = {
    null: () => null,
    any: (v) => v,
    boolean: (v) => Boolean(v),
    string: (v) => (v === null || v === undefined ? "" : String(v)),
    object: (v) => (typeof v === "object" && v !== null ? v : {}),
    array: (v) => (Array.isArray(v) ? v : []),
    integer: (v) => {
      const n = Number(v);
      return Number.isInteger(n) ? n : 0;
    },
    number: (v) => Number(v),
  };
  return m[jsonType] ?? ((v) => v);
}

/**
 * 归一化 UdfSchema（1.0）：parametersSchema 唯一声明形态——扁平 parameters
 * 由 parametersSchema 派生（运行时绑定缓存，funcBindParams/positionalParams
 * 的执行素材）；扁平声明入口已随 1.0 移除（B 案终裁）。
 */
function normalizeUdfSchema(
  schema: UdfSchema,
  namespace: string,
): UdfSchema & {
  parameters: Record<string, UdfSchemaParameter>;
} {
  const normalized: UdfSchema & { parameters: Record<string, UdfSchemaParameter> } = {
    parameters: {},
    returns: schema.returns ?? { type: "null" },
    namespace,
    description: schema.description,
    semantics: schema.semantics ?? "query",
    temporal: schema.temporal ?? "event",
    stateful: schema.stateful ?? false,
    fidelity: schema.fidelity ?? "exact-per-event",
    deprecated: schema.deprecated,
  };

  if (schema.parametersSchema) {
    normalized.parametersSchema = schema.parametersSchema;
    const derived: Record<string, UdfSchemaParameter> = {};
    for (const [name, prop] of Object.entries(schema.parametersSchema.properties)) {
      // JSON Schema 联合类型（type 数组）与 anyOf：派生为 'any'（绑定透传不折值）——
      // 曾错误归 'null' 致该类参数绑定值一律被置 null（ADR-015 实施期发现）
      derived[name] = {
        type: typeof prop.type === "string" ? prop.type : Array.isArray(prop.type) || prop.anyOf ? "any" : "null",
        description: prop.description,
        default: prop.default,
      };
    }
    normalized.parameters = derived;
  }

  if (schema.returnsSchema) {
    normalized.returnsSchema = schema.returnsSchema;
    if (!normalized.returns || normalized.returns.type === undefined) {
      normalized.returns = {
        type: schema.returnsSchema.type,
        description: schema.returnsSchema.description,
      };
    }
  }

  return normalized;
}

class UdfRegistry {
  private functions = new Map<string, UdfEntry>();
  /** ADR-009：pack 元数据（namespace → meta），目录徽标/过滤的数据源；setPackMeta 写入 */
  private packMetas = new Map<string, UdfPackMeta>();

  /**
   * 平台硬化：跨名冲突校验——裸 kind 解析中 namespace 优先，函数名/namespace 交叉同名
   * 会使其中一方 kind 不可达，注册期直接失败（force 可显式接管）。
   * 函数名与自身 namespace 同名（如 contrib/roster.ts 的 roster 工具）为遗留既定契约，放行：
   * 语义确定为 namespace 优先。
   */
  private assertNoNamespaceCollision(name: string, namespace: string): void {
    const existingNamespaces = new Set<string>();
    for (const entry of this.functions.values()) {
      if (entry.schema.namespace !== undefined) {
        existingNamespaces.add(entry.schema.namespace);
      }
    }
    if (name !== namespace && existingNamespaces.has(name)) {
      throw new Error(
        `[udf] 函数 '${name}' 与现有 namespace 同名：裸 kind 解析时 namespace 优先，函数锁定 kind 不可达（force 可显式接管）`,
      );
    }
    if (name !== namespace && [...this.functions.keys()].some((fnName) => fnName === namespace)) {
      throw new Error(
        `[udf] namespace '${namespace}' 与现有函数同名：其中函数的裸 kind 解析将命中 namespace（force 可显式接管）`,
      );
    }
  }

  registerFunction(
    fn: UdfFunction,
    /** 1.0 起必填——不存在默认命名空间（'default' 已入保留清单） */
    namespace: string,
    schema?: UdfSchema,
    nameOverride?: string,
    options?: { force?: boolean },
  ): void {
    const name = nameOverride ?? fn.name;
    if (!name) {
      throw new Error("Function must have a name to register");
    }
    const reserved = reservedNamespaceViolation(namespace);
    if (reserved) {
      throw new Error(`[udf] ${reserved}`);
    }
    if (!options?.force) {
      this.assertNoNamespaceCollision(name, namespace);
    }
    this.functions.set(name, {
      fn,
      schema: normalizeUdfSchema(
        {
          returns: schema?.returns ?? { type: "null" },
          namespace,
          semantics: schema?.semantics,
          temporal: schema?.temporal,
          stateful: schema?.stateful,
          fidelity: schema?.fidelity,
          parametersSchema: schema?.parametersSchema,
          returnsSchema: schema?.returnsSchema,
          description: schema?.description,
          deprecated: schema?.deprecated,
        },
        namespace,
      ),
    });
  }

  /** 批量注册工具定义（UdfPack 装载内部通道；namespace 必填） */
  registerTools(defs: ContribToolDef[], namespace: string): void {
    for (const def of defs) {
      this.registerFunction(
        def.fn,
        namespace,
        {
          description: def.description,
          parametersSchema: def.parametersSchema,
          returnsSchema: def.returnsSchema,
          semantics: def.semantics,
          idempotent: def.idempotent,
          deprecated: def.deprecated,
        },
        def.name,
      );
    }
  }

  /**
   * 位置参数前置校验（执行规范 §6.1）：对已求值、未绑定的位置参数检查必填项。
   * 返回错误清单（空数组 = 通过）。缺省参数在 funcBindParams 中回退，不算缺失。
   */
  /**
   * R1（ADR-011）：位置参数序列——规范表示直读（input schema 的
   * properties 键序 = 绑定序；required 数组 + default 决定必填）。
   * legacy 无 parametersSchema 的 schema 回退读扁平（required = 无 default）。
   */
  private positionalParams(name: string): {
    name: string;
    jsonType: string | null; // 简单类型（可矫正）；null = 复杂 schema（透传不矫正）
    description?: string;
    hasDefault: boolean;
    default: unknown;
    required: boolean; // required 且无 default
  }[] {
    const schema = this.udfFunctionSchema(name);
    if (!schema) return [];
    const ps = schema.parametersSchema;
    if (ps && typeof ps === "object" && ps.properties) {
      const required = new Set((ps as { required?: string[] }).required ?? []);
      return Object.entries(ps.properties).map(([paramName, prop]) => {
        const hasDefault = prop !== null && typeof prop === "object" && prop.default !== undefined;
        const jsonType = prop && typeof prop === "object" && typeof prop.type === "string" ? prop.type : null;
        return {
          name: paramName,
          jsonType,
          description: prop && typeof prop === "object" ? prop.description : undefined,
          hasDefault,
          default: hasDefault ? (prop as { default: unknown }).default : undefined,
          required: required.has(paramName) && !hasDefault,
        };
      });
    }
    // 1.0：扁平声明已移除——无 parametersSchema 的函数无位置参数
    // （normalized.parameters 缓存仅供 funcBindParams 兼容读取，不再回退声明）
    return [];
  }

  validatePositionalArgs(name: string, args: unknown[]): string[] {
    if (!this.functions.has(name)) return [];
    const issues: string[] = [];
    this.positionalParams(name).forEach((param, i) => {
      const value = i < args.length ? args[i] : undefined;
      if (value === undefined || value === null) {
        // 缺必填位（R1）：不再静默跳过——契约 §5.2 要求列出参数名与位置
        if (param.required) {
          issues.push(`${param.name} is required (position ${i})`);
        }
        return; // 可选缺位由 funcBindParams 以默认值补齐
      }
    });
    return issues;
  }

  /**
   * 按名校验（ADR-015 调用规范 §3）：位置校验（validatePositionalArgs）的具名
   * 对应物——三类结构化清单（与编辑面参数漂移带同构，编辑时孪生）：
   * missing（声明且必填但缺）/ extra（未声明键）/ typeMismatch（声明类型不符）。
   * 未注册函数返回空清单（与位置校验同款宽容）。
   * 信封识别用 instances/envelope.ts 单源（1.5.0：消灭本类私有双轨副本——
   * 旧副本未跟 OQ2 的 literal 原始类型裁定，literal 非字符串值此前走不到直校分支）。
   */

  validateNamedArgs(
    name: string,
    kwargs: Record<string, unknown>,
  ): {
    missing: string[];
    extra: string[];
    typeMismatch: Array<{ name: string; expected: string; actual: string }>;
  } {
    if (!this.functions.has(name)) return { missing: [], extra: [], typeMismatch: [] };
    const declared = new Map(this.positionalParams(name).map((param) => [param.name, param]));
    const missing: string[] = [];
    const extra: string[] = [];
    const typeMismatch: Array<{ name: string; expected: string; actual: string }> = [];
    // missing 按声明参数集判定（缺失 = kwargs 中无此键，与遍历无关）
    for (const param of declared.values()) {
      if (param.required && (kwargs[param.name] === undefined || kwargs[param.name] === null)) {
        missing.push(param.name);
      }
    }
    // ADR-016 mode 感知：信封值按模式校验（literal 按声明类型直校；object/array
    // value 禁止——与顶层原始类型一致；expression 不做静态校验，执行错误语义覆盖）
    for (const [key, raw] of Object.entries(kwargs)) {
      const param = declared.get(key);
      if (!param) {
        extra.push(key);
        continue;
      }
      const envelope = asTypedValueEnvelope(raw);
      if (envelope) {
        if (envelope.mode === "literal") {
          // literal 按声明类型直校（OQ2：value 允许原始类型；object/array 值
          // 在单源窄识别下非信封，走下方普通校验按类型不符报）
          if (param.jsonType && !matchJsonType(envelope.value, param.jsonType)) {
            typeMismatch.push({ name: key, expected: param.jsonType, actual: describeJsonType(envelope.value) });
          }
        }
        // expression/reference：值按声明类型直校（路径形态本为字符串）
        continue;
      }
      if (raw !== undefined && raw !== null && param.jsonType != null && !matchJsonType(raw, param.jsonType)) {
        typeMismatch.push({ name: key, expected: param.jsonType, actual: describeJsonType(raw) });
      }
    }
    return { missing, extra, typeMismatch };
  }

  /**
   * 返回值契约校验（执行规范 §6.5）：按 returnsSchema 顶层断言
   * （type / required / properties 浅层类型）。返回错误清单（空数组 = 通过）。
   */
  validateResult(name: string, result: unknown): string[] {
    const schema = this.functions.get(name)?.schema;
    const rs = schema?.returnsSchema;
    if (!rs) return [];
    const issues: string[] = [];
    if (typeof rs.type === "string" && rs.type !== "any" && rs.type !== "null" && !matchJsonType(result, rs.type)) {
      issues.push(`result type expected ${rs.type}, got ${describeJsonType(result)}`);
    }
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const record = result as Record<string, unknown>;
      for (const key of rs.required ?? []) {
        if (record[key] === undefined) {
          issues.push(`result.${key} is required`);
        }
      }
      for (const [key, prop] of Object.entries(rs.properties ?? {})) {
        const value = record[key];
        if (value === undefined) continue;
        const propType = typeof prop?.type === "string" ? prop.type : undefined;
        if (propType && propType !== "any" && !matchJsonType(value, propType)) {
          issues.push(`result.${key} type expected ${propType}, got ${describeJsonType(value)}`);
        }
      }
    }
    return issues;
  }

  /** 归一化 schema（含由 parametersSchema 派生的扁平 parameters 绑定缓存） */
  udfFunctionSchema(name: string): (UdfSchema & { parameters: Record<string, UdfSchemaParameter> }) | undefined {
    return this.functions.get(name)?.schema as
      | (UdfSchema & { parameters: Record<string, UdfSchemaParameter> })
      | undefined;
  }

  funcBindParams(name: string, args: unknown[]): Record<string, unknown> {
    const params = this.positionalParams(name);
    const missing = params.filter(
      (param, i) => param.required && (i >= args.length || args[i] === undefined || args[i] === null),
    );
    if (missing.length > 0) {
      // 契约 §5.3：必填缺失 MUST NOT 静默填空（直调绕过 validate 时同样拦截）
      throw new Error(
        `INVALID_PARAM: ${missing.map((m) => `${m.name} is required (position ${params.indexOf(m)})`).join("; ")}`,
      );
    }
    const bound: Record<string, unknown> = {};
    params.forEach((param, i) => {
      const val = i < args.length ? args[i] : param.hasDefault ? param.default : null;
      const converter = param.jsonType ? jsonT2pyT(param.jsonType) : (v: unknown) => v;
      bound[param.name] = converter(val);
    });
    return bound;
  }

  /**
   * 命名形态绑定（调用形态第三种：对象 = $call + 具名实参）：按名字绑定，
   * 与位置语义共享 required/default/type 转换规则；未知参数名报错（手写图防笔误）。
   */
  bindNamedArgs(name: string, named: Record<string, unknown>): { kwargs: Record<string, unknown>; issues: string[] } {
    const schema = this.udfFunctionSchema(name);
    if (!schema?.parameters) {
      return { kwargs: { ...named }, issues: [] };
    }
    const issues: string[] = [];
    const known = new Set(Object.keys(schema.parameters));
    for (const key of Object.keys(named)) {
      if (!known.has(key)) {
        issues.push(`unknown argument '${key}'`);
      }
    }
    const kwargs: Record<string, unknown> = {};
    for (const [paramName, paramSchema] of Object.entries(schema.parameters)) {
      const provided = paramName in named;
      const raw = provided ? named[paramName] : undefined;
      if (!provided || raw === undefined || raw === null) {
        if (paramSchema.default === undefined) {
          issues.push(`${paramName} is required`);
        } else {
          kwargs[paramName] = paramSchema.default;
        }
        continue;
      }
      kwargs[paramName] = jsonT2pyT(paramSchema.type ?? "null")(raw);
    }
    return { kwargs, issues };
  }

  async call(udfName: string, kwargs?: Record<string, unknown>, callCtx?: ToolContext): Promise<unknown> {
    const entry = this.functions.get(udfName);
    if (!entry) {
      throw new Error(`Function '${udfName}' is not registered in UdfRegistry`);
    }
    const result = entry.fn(kwargs ?? {}, callCtx && { ...callCtx, namespace: entry.schema.namespace });
    return result instanceof Promise ? await result : result;
  }

  /** 扁平 schema 数组(旧接口，保持兼容) */
  udfFunctionSchemaTools(): unknown[] {
    const funcTools: unknown[] = [];
    for (const entry of this.functions.values()) {
      funcTools.push(entry.schema);
    }
    return funcTools;
  }

  /**
   * namespace 分组 + tools 格式，与 brdeapi.geetest.com/zen_custom_node_function.json 对齐。
   * 每个 namespace 对应侧边栏 group，每个 tool 对应 createJdmNode 的 kind。
   * type 恒为 'namespace'(集合容器档；契约字段保留供未来场景)。
   * ADR-009：pack 元数据（若有）随 namespace 透传，目录据此渲染 origin 徽标。
   */
  /** ADR-009：记录 pack 元数据（目录徽标/过滤数据源）；同 namespace 后写覆盖 */
  setPackMeta(namespace: string, meta: UdfPackMeta): void {
    this.packMetas.set(namespace, meta);
  }

  getPackMeta(namespace: string): UdfPackMeta | undefined {
    return this.packMetas.get(namespace);
  }

  /** 回放钉扎（1.5.0）：函数所属 pack 的 meta.version——审计 observed 与回放校验的版本源；未声明版本的 pack 返回 undefined（不参与钉扎） */
  udfPackVersion(name: string): string | undefined {
    const fn = this.functions.get(name);
    const ns = (fn as { schema?: { namespace?: string } } | undefined)?.schema?.namespace;
    return ns ? this.packMetas.get(ns)?.version : undefined;
  }

  /** 声明式出口清单（1.6.0）：函数所属 pack 的声明域白名单——宿主 EgressGuard 交叉校验的数据源；无声明 pack 返回 undefined（策略全权归端口） */
  udfEgress(name: string): readonly string[] | undefined {
    const fn = this.functions.get(name);
    const ns = (fn as { schema?: { namespace?: string } } | undefined)?.schema?.namespace;
    return ns ? this.packMetas.get(ns)?.egress?.allow : undefined;
  }

  /**
   * 唯一注册入口（CONTRACT §4）：接受规范工具对象（tool() 产物）的 pack/集合。
   * 注册语义（deploy 期 fail fast，CONTRACT §4）：跨工具撞名列出已注册 namespace、
   * act 治理字段经 registerFunction 既有管道、pack meta 随 namespace 落账。
   */
  register(entry: {
    id?: string;
    meta?: UdfPackMeta;
    // S012：复用 UdfTool 类型（消除手写内联漂移根因）；namespace 可选（回退 pack id）
    tools: Array<Omit<UdfTool, "namespace"> & { namespace?: string; overwrite?: boolean }>;
  }): void {
    const fallbackNs = entry.id;
    if (entry.meta && entry.id) {
      this.setPackMeta(entry.id, entry.meta);
    }
    const seen = new Map<string, string>();
    for (const t of entry.tools) {
      const namespace = t.namespace ?? fallbackNs;
      if (!namespace) {
        throw new Error(`[udf] tool '${t.name}' requires a namespace (or pack id)`);
      }
      const reserved = reservedNamespaceViolation(namespace);
      if (reserved) {
        throw new Error(`[udf] ${reserved}`);
      }
      const existing = this.functions.get(t.name);
      if (existing && !t.overwrite) {
        throw new Error(
          `[udf] tool '${t.name}' already registered by namespace '${existing.schema.namespace}' (declare overwrite: true to take over)`,
        );
      }
      if (t.meta) {
        this.setPackMeta(namespace, t.meta);
      }
      // OQ1 裁定（ADR-021）：temporal/fidelity/stateful = pack 级缺省 + tool 级覆盖
      // （velocityPack 单 pack 多工具省声明；与幂等键 tool 级覆盖不做的 §1.3 裁定不冲突——
      // 那是幂等「键」的单源，本处是声明的继承序）
      this.registerFunction(
        t.run as UdfFunction,
        namespace,
        {
          description: t.description,
          parametersSchema: t.inputSchema as UdfSchema["parametersSchema"],
          returnsSchema: t.outputSchema as UdfSchema["returnsSchema"],
          semantics: t.semantics,
          temporal: t.temporal ?? entry.meta?.temporal ?? "event",
          stateful: t.stateful ?? entry.meta?.stateful ?? false,
          fidelity: t.fidelity ?? entry.meta?.fidelity ?? "exact-per-event",
          idempotent: t.idempotent,
          deprecated: t.deprecated,
        },
        t.name,
      );
      seen.set(t.name, namespace);
    }
  }

  /** CONTRACT §5.2 别名：validatePositional */
  validatePositional(name: string, input: Record<string, unknown>): string[] {
    return this.validatePositionalArgs(
      name,
      this.positionalParams(name).map((param) => input?.[param.name] ?? undefined),
    );
  }

  /** CONTRACT §5.3 别名：bindPositional = 位置式绑定 */
  bindPositional(name: string, args: unknown[]): Record<string, unknown> {
    return this.funcBindParams(name, args);
  }

  /** CONTRACT §3 目录视图别名 */
  catalog(): CustomNodeNamespace[] {
    return this.udfFunctionSchemaNamespaces();
  }

  udfFunctionSchemaNamespaces(): CustomNodeNamespace[] {
    const namespaces = new Map<string, CustomNodeNamespace>();
    for (const [name, entry] of this.functions.entries()) {
      // 手工 schema 可能未带 namespace（normalizeUdfSchema 显式供给前的直构形态）——目录归 'ungrouped'
      const ns = entry.schema.namespace ?? "ungrouped";
      let nsObj = namespaces.get(ns);
      if (!nsObj) {
        nsObj = {
          type: "namespace",
          title: ns,
          name: ns,
          description: "",
          tools: [],
          ...(this.packMetas.has(ns) ? { meta: this.packMetas.get(ns) } : {}),
        };
        namespaces.set(ns, nsObj);
      }
      nsObj.tools.push({
        name,
        title: name,
        type: "function",
        description: entry.schema.description ?? "",
        parameters: entry.schema.parametersSchema ?? {
          properties: {},
          title: name,
          type: "object",
        },
        returns: entry.schema.returnsSchema ?? { type: "null", title: "", properties: {} },
        namespace: ns,
        kind: ns,
        semantics: entry.schema.semantics ?? "query",
        idempotent: entry.schema.idempotent,
        deprecated: entry.schema.deprecated,
      });
    }
    return [...namespaces.values()];
  }
}

const globalUdfRegistry = new UdfRegistry();

/**
 * contrib 域单工具定义（UdfPack.tools 数组项；字段与 UdfSchema 注册参数一致）。
 * 1.0 起这是宿主业务包（verdict 纯数据+处理器注入）的工具形态——contrib 参考域
 * 已全部迁理想态 tool()/pack()，遗留 defineContrib/defineTool 出口已移除。
 */
export interface ContribToolDef {
  name: string;
  description?: string;
  /** 算子语义（Y1）：缺省 'query' */
  semantics?: UdfSemantics;
  /** act 语义幂等声明（Z1）：建议 act 工具显式声明 */
  idempotent?: boolean;
  parametersSchema?: UdfSchema["parametersSchema"];
  returnsSchema?: UdfSchema["returnsSchema"];
  /** 弃用标记（A4）：透传至 schema/目录/补全；replacement 指引替代函数 */
  deprecated?: { since?: string; note?: string; replacement?: string };
  /**
   * ADR-009：跨 namespace 函数名撞名时的显式接管声明——true 时免撞名失败，
   * 后注册者覆盖（与 registerFunction 的 force 同语义，报错信息会提示本出口）。
   */
  overwrite?: boolean;
  fn: UdfFunction;
}

/**
 * UdfPack：宿主业务函数包契约（verdict 等仓以纯数据 + 处理器形态注入）。
 * namespace 对应编辑器侧边栏 group 与 customNode 的 kind 域；注册是 deploy-time
 * 静态行为，租户差异在调用时经 ExecContext/端口解析，禁止 per-tenant 注册。
 */
export interface UdfPack {
  namespace: string;
  tools: ContribToolDef[];
  /** ADR-009：pack 元数据（目录徽标/过滤的数据基础）；缺省 = 无徽标（向后兼容） */
  meta?: UdfPackMeta;
}

/** ADR-009：pack 来源生态位（目录 origin 徽标的取值域） */
export type UdfPackOrigin = "reference" | "extension" | "industry";

/**
 * ADR-009 pack 元数据——目录渲染与过滤的最小集。实施加强注记 2：元数据字段一旦
 * 发布即兼容性 surface，宁可后加不可先滥；禁止收描述类内容（description/title
 * 各有归属）。
 */
export interface UdfPackMeta {
  origin: UdfPackOrigin;
  /** 目录过期提示（目录可对比 registry 内版本与最新发布） */
  version: string;
  license?: "oss" | "proprietary";
  /** 状态算子 pack 级缺省（ADR-021，OQ1 裁定）：单 pack 多工具省声明；tool 级显式声明覆盖 */
  temporal?: "event" | "processing";
  stateful?: boolean;
  fidelity?: UdfFidelity;
  /** 声明式出口清单（1.6.0，调研增量④/Figma networkAccess 模式）：pack 网络出口
   * 的声明域白名单（`example.com` 精确 / `*.example.com` 通配；无 scheme/路径，
   * 不设 `*` 全通——策略面仍归 EgressGuard 端口，本声明是其交叉校验的数据源）。
   * 声明语义 =「本 pack 设计上只出这些域」；宿主组合根可校验 声明 ⊆ 租户运行时
   * 白名单，guard 实现可按 udfEgress(name) 收紧到声明内。 */
  egress?: { allow: string[] };
}

/** 声明域模式校验：`example.com` 精确 / `*.example.com` 通配；禁 scheme/路径/`*` 全通 */
const EGRESS_DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * 声明域匹配（1.6.0）：URL 的 host 是否落声明白名单内——精确相等或通配后缀
 * （`*.api.example.com` 命中 `v1.api.example.com`，不命中 `api.example.com`
 * 本体；`*` 全通不支持，缺省声明 = 无声明面，策略全权归 EgressGuard）。
 * 供宿主 EgressGuard 实现做「声明内收紧」的纯函数，机制层默认不强制。
 */
export const egressHostMatches = (allow: readonly string[], url: string): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allow.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // '.api.example.com'
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === p;
  });
};

/**
 * ADR-009 namespace 立法：保留前缀给 zen-udf 本体与参考域，宿主通用扩展与行业包
 * 禁用（精确名或点分前缀命中，如 'zen'/'zen.ext' 拒绝、'zenkit' 放行）。
 */
export const RESERVED_NAMESPACE_PREFIXES: readonly string[] = ["zen", "core", "reference", "builtin", "default"];

export const reservedNamespaceViolation = (namespace: string): string | null => {
  const hit = RESERVED_NAMESPACE_PREFIXES.find((r) => namespace === r || namespace.startsWith(`${r}.`));
  return hit ? `namespace '${namespace}' uses reserved prefix '${hit}' (ADR-009)` : null;
};

/**
 * act 幂等声明警告（Z1）：act 语义工具未声明 idempotent 时产生警告（不阻断注册）。
 * 警告与错误分离：errors 阻断，warnings 仅提示（verdict 登记页可见）。
 */
export function packWarnings(pack: UdfPack): string[] {
  const warnings: string[] = [];
  for (const tool of pack.tools) {
    if (tool.semantics === "act" && tool.idempotent !== true) {
      warnings.push(
        `act tool '${tool.name}' has no idempotent declaration — replay/submission dedup relies on decisionId at the sink`,
      );
    }
  }
  return warnings;
}

export interface PackQualityIssue {
  check: string;
  tool?: string;
  severity: "error" | "warning";
  detail: string;
}

/**
 * 宿主包质量检查（validatePack 硬门禁之上的软层，C 项）：编辑器展示与执行规范
 * 约定的结构质量——description 非空、returnsSchema 存在（§6.5 前提）、
 * required ⊆ properties、timeout 属性形状（§6.2）、act 幂等声明（Z1，warning）。
 * 注册前的形状硬校验仍由 validatePack 独立承担；本函数供宿主 CI 与 verdict 登记页使用。
 */
export function packChecks(pack: UdfPack): PackQualityIssue[] {
  const namespace = pack.namespace ?? "";
  const issues: PackQualityIssue[] = [];
  if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) {
    issues.push({
      check: "namespace-convention",
      severity: "warning",
      detail: `namespace '${pack.namespace}' deviates from the lowercase kebab/snake convention`,
    });
  }
  for (const tool of pack.tools) {
    const at = (check: string, severity: "error" | "warning", detail: string): PackQualityIssue => ({
      check,
      tool: tool.name,
      severity,
      detail,
    });
    if (!tool.description || !tool.description.trim()) {
      issues.push(at("description-required", "error", "description is empty — the editor node panel renders it"));
    }
    if (!tool.returnsSchema) {
      issues.push(at("returns-schema-required", "error", "returnsSchema is required (§6.5 result contract premise)"));
    }
    const props = tool.parametersSchema?.properties;
    if (tool.parametersSchema?.required && props) {
      for (const key of tool.parametersSchema.required) {
        if (!(key in props)) {
          issues.push(at("required-mismatch", "error", `required key '${key}' has no entry in properties`));
        }
      }
    }
    const timeoutProp = props?.timeout;
    if (timeoutProp && timeoutProp.type !== "integer") {
      issues.push(
        at(
          "timeout-shape",
          "warning",
          `timeout property type '${String(timeoutProp.type)}' should be 'integer' (§6.2)`,
        ),
      );
    }
    if (tool.semantics === "act" && tool.idempotent !== true) {
      issues.push(at("act-idempotent", "warning", "act tool without idempotent declaration (Z1)"));
    }
  }
  return issues;
}

/** 校验 UdfPack 形状，返回错误清单（空数组 = 通过）。createUdfRuntime 注册前自动调用 */
export function validatePack(pack: UdfPack): string[] {
  const errors: string[] = [];
  if (!pack.namespace || typeof pack.namespace !== "string") {
    errors.push("namespace is required and must be a non-empty string");
  } else {
    const reserved = reservedNamespaceViolation(pack.namespace);
    if (reserved) {
      errors.push(reserved);
    }
  }
  if (pack.meta !== undefined) {
    const { meta } = pack;
    if (typeof meta !== "object" || meta === null) {
      errors.push("meta must be an object");
    } else {
      if (!["reference", "extension", "industry"].includes(meta.origin)) {
        errors.push(`meta.origin must be one of reference/extension/industry (got '${meta.origin}')`);
      }
      if (!meta.version || typeof meta.version !== "string") {
        errors.push("meta.version is required and must be a non-empty string");
      }
      if (meta.license !== undefined && !["oss", "proprietary"].includes(meta.license)) {
        errors.push(`meta.license must be 'oss' or 'proprietary' (got '${meta.license}')`);
      }
      if (meta.egress !== undefined) {
        const egress = meta.egress as { allow?: unknown };
        if (typeof egress !== "object" || egress === null || !Array.isArray(egress.allow)) {
          errors.push("meta.egress must be an object with allow: string[]");
        } else {
          egress.allow.forEach((domain, i) => {
            if (typeof domain !== "string" || !EGRESS_DOMAIN_PATTERN.test(domain)) {
              errors.push(
                `meta.egress.allow[${i}] '${domain}' must be a domain (example.com or *.example.com; no scheme, path or bare asterisk)`,
              );
            }
          });
        }
      }
    }
  }
  if (!Array.isArray(pack.tools) || pack.tools.length === 0) {
    errors.push("tools must be a non-empty array");
    return errors;
  }
  const seen = new Set<string>();
  for (const tool of pack.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      errors.push("every tool requires a non-empty string name");
      continue;
    }
    if (typeof tool.fn !== "function") {
      errors.push(`tool '${tool.name}' requires a function fn`);
    }
    if (tool.parametersSchema && typeof tool.parametersSchema !== "object") {
      errors.push(`tool '${tool.name}' parametersSchema must be an object`);
    }
    if (tool.parametersSchema && !tool.parametersSchema.properties) {
      errors.push(`tool '${tool.name}' parametersSchema.properties is required`);
    }
    if (tool.semantics !== undefined && !UDF_SEMANTICS.includes(tool.semantics)) {
      errors.push(`tool '${tool.name}' semantics must be one of query/observe/act`);
    }
    if (seen.has(tool.name)) {
      errors.push(`duplicate tool name '${tool.name}' within pack`);
    }
    seen.add(tool.name);
  }
  return errors;
}

export interface CreateUdfRuntimeOptions {
  /** 业务函数包（deploy-time 注入）；注册前逐个 validatePack，违例整体失败 */
  packs?: UdfPack[];
  /** 策略层端口（CONTRACT §6）：组合根一次注入，handlers 经 getPorts() 读取（单进程语义） */
  ports?: UdfPorts;
}

/**
 * 构建隔离的 UdfRegistry 实例（U6）：多运行时/多租户实例注入的推荐入口。
 * 参考函数域按需经 loadReferenceInto(registry) 装载（builtin: 'reference' 语义）。
 */
export function createUdfRuntime(options: CreateUdfRuntimeOptions = {}): UdfRegistry {
  const registry = new UdfRegistry();
  if (options.ports) setPorts(options.ports);
  // ADR-009 撞名检测（deploy 期 fail fast，报错列出冲突 namespace——实施加强注记 1）：
  // 跨 pack 的工具名重复即失败（分发按裸函数名，重复即覆盖歧义），除非工具显式
  // 声明 overwrite；pack namespace 重复为配置错误，一并失败。
  const nameOwners = new Map<string, string>();
  const seenPackNamespaces = new Set<string>();
  for (const pack of options.packs ?? []) {
    const errors = validatePack(pack);
    if (seenPackNamespaces.has(pack.namespace)) {
      errors.push(`duplicate pack namespace '${pack.namespace}'`);
    }
    for (const tool of pack.tools) {
      const owner = nameOwners.get(tool.name);
      if (owner !== undefined && owner !== pack.namespace && tool.overwrite !== true) {
        errors.push(
          `tool '${tool.name}' already registered by namespace '${owner}' (declare overwrite: true to take over)`,
        );
      }
    }
    if (errors.length > 0) {
      throw new Error(`[udf] invalid UdfPack '${pack.namespace}': ${errors.join("; ")}`);
    }
    seenPackNamespaces.add(pack.namespace);
    for (const tool of pack.tools) {
      if (!nameOwners.has(tool.name)) {
        nameOwners.set(tool.name, pack.namespace);
      }
    }
    for (const warning of packWarnings(pack)) {
      console.warn('[udf] pack "' + pack.namespace + '" warning: ' + warning);
    }
    registry.registerTools(pack.tools, pack.namespace);
    if (pack.meta) {
      registry.setPackMeta(pack.namespace, pack.meta);
    }
  }
  return registry;
}

export { globalUdfRegistry, UdfRegistry };
