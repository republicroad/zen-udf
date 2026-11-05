import type { EgressGuard, SecretResolver } from "@republicroad/zen-udf";
import { getExecContext, getPorts, globalUdfRegistry, pack, tool, type ToolContext } from "@republicroad/zen-udf";

// http 域(http_request 函数，有专属 UI 设计，文件名即 namespace)
//
// ADR-011/012 迁移完成（1.0）：端口经组合根 createUdfRuntime({ ports }) 注入，
// 本域经 getPorts() 读取——configureHttpUdf 模块单例已随 1.0 移除。
import { Type } from "@sinclair/typebox";







// 回退导出（ports.ts 为统一出处，此处 re-export 保持既有消费方兼容）
export type { EgressGuard, SecretResolver };

const SECRET_REF_PATTERN = /^\$\{secret:([^}]+)\}$/;

/** notify 等其他出网 contrib 复用同一出口/凭证配置面（组合根 getPorts 单源） */
export const currentEgressPolicy = (): { egressGuard?: EgressGuard; secretResolver?: SecretResolver } => getPorts();

export { SECRET_REF_PATTERN };

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 200;
const DEFAULT_MAX_BYTES = 1024 * 1024;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const httpErrorResult = (error: string) => ({ status: 0, headers: {}, body: null, error });

const coerceCount = (value: unknown, min: number, max: number, fallback: number): number => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
};

const buildUrlWithParams = (rawUrl: string, params: Record<string, unknown>): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
};

const applyAuthHeader = (requestHeaders: Record<string, string>, auth: Record<string, unknown>): void => {
  const hasAuthorization = Object.keys(requestHeaders).some((k) => k.toLowerCase() === "authorization");
  if (hasAuthorization) {
    return;
  }
  const type = String(auth.type ?? "")
    .trim()
    .toLowerCase();
  if (type === "basic") {
    const raw = `${String(auth.username ?? "")}:${String(auth.password ?? "")}`;
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    requestHeaders["authorization"] = `Basic ${encoded}`;
  } else if (type === "bearer") {
    const token = String(auth.token ?? "");
    if (token) {
      requestHeaders["authorization"] = `Bearer ${token}`;
    }
  }
};

interface HttpAttemptResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: undefined | string;
  policyBlocked?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetryResult = (result: HttpAttemptResult): boolean =>
  !result.policyBlocked && (result.status === 0 || result.status === 429 || result.status >= 500);

/** 裸函数形态（kwargs 签名）：测试与纯函数消费方沿用 */
export const httpRequest = async function httpRequestUdf(kwargs: Record<string, unknown>, call?: ToolContext) {
  return runHttpRequest(kwargs, call);
};

async function runHttpRequest(kwargs: Record<string, unknown>, call?: ToolContext) {
  const rawUrl = String(kwargs?.url ?? "").trim();
  const method =
    String(kwargs?.method ?? "GET")
      .trim()
      .toUpperCase() || "GET";
  const rawBody = asRecord(kwargs?.body);
  const rawParams = asRecord(kwargs?.params);
  const rawAuth = asRecord(kwargs?.auth);
  const retryCount = coerceCount(kwargs?.retry, 0, MAX_RETRIES, 0);

  if (!rawUrl) {
    return httpErrorResult("url is required");
  }
  if (!HTTP_METHODS.has(method)) {
    return httpErrorResult(`unsupported http method '${method}'`);
  }

  const url = buildUrlWithParams(rawUrl, rawParams);
  if (!url) {
    return httpErrorResult(`invalid url '${rawUrl}'`);
  }

  const tenantId = getExecContext()?.tenantId;
  // 端口每次执行时从组合根读取（getPorts 单源）——注入时机与 per-call 测试注入均生效
  const { egressGuard, secretResolver } = currentEgressPolicy();
  try {
    await egressGuard?.assertAllowed(url, tenantId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ...httpErrorResult("egress blocked by policy: " + reason), policyBlocked: true };
  }

  const effectiveAuth = { ...rawAuth };
  try {
    if (secretResolver) {
      for (const key of ["username", "password", "token"]) {
        const value = effectiveAuth[key];
        if (typeof value === "string") {
          const ref = value.match(SECRET_REF_PATTERN);
          if (ref) {
            effectiveAuth[key] = await secretResolver.resolve(ref[1], tenantId);
          }
        }
      }
    } else {
      for (const key of ["username", "password", "token"]) {
        if (typeof effectiveAuth[key] === "string" && SECRET_REF_PATTERN.test(effectiveAuth[key])) {
          return {
            ...httpErrorResult(`secret reference in auth.${key} requires a configured secretResolver`),
            policyBlocked: true,
          };
        }
      }
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ...httpErrorResult("secret resolve failed: " + reason), policyBlocked: true };
  }

  const requestHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(kwargs?.headers))) {
    requestHeaders[String(key)] = String(value);
  }
  applyAuthHeader(requestHeaders, effectiveAuth);

  let requestBody: string | undefined;
  if (method !== "GET" && method !== "HEAD" && Object.keys(rawBody).length > 0) {
    requestBody = JSON.stringify(rawBody);
    const hasContentType = Object.keys(requestHeaders).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType) {
      requestHeaders["content-type"] = "application/json";
    }
  }

  const maxBytes = coerceCount(kwargs?.maxBytes, 1024, 64 * 1024 * 1024, DEFAULT_MAX_BYTES);
  const attemptOnce = async (): Promise<HttpAttemptResult> => {
    const controller = new AbortController();
    const signal =
      call?.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, call.signal])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal,
      });
      let responseText = "";
      let totalBytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            controller.abort();
            return {
              status: 0,
              headers: {},
              body: null,
              error: `response exceeds maxBytes (${maxBytes} bytes)`,
              policyBlocked: true,
            };
          }
          responseText += decoder.decode(value, { stream: true });
        }
        responseText += decoder.decode();
      } else {
        responseText = await response.text();
      }
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    } catch (e) {
      return { status: 0, headers: {}, body: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };

  const timeoutMs = coerceCount(kwargs?.timeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  let result = await attemptOnce();
  for (let attempt = 1; attempt <= retryCount && shouldRetryResult(result); attempt += 1) {
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    result = await attemptOnce();
  }
  return result;
}

export const http_request = tool({
  namespace: "http",
  name: "http_request",
  title: "http_request",
  description:
    "发起 HTTP 请求, 返回响应结果 { status, headers, body }. 支持 params 查询参数合并、timeout 单次超时(默认 10s, 上限 60s)、" +
    'retry 重试(仅网络异常/超时/5xx/429, 指数退避)与 auth 认证({ type: "basic", username, password } 或 { type: "bearer", token }, ' +
    "headers 显式 Authorization 优先). 失败返回结构化错误 { status: 0, error }, 不抛出异常.",
  semantics: "query",
  input: Type.Object({
    url: Type.String({ title: "URL", description: "请求地址" }),
    method: Type.Optional(
      Type.String({
        title: "Method",
        description: "HTTP 方法(GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)，默认 GET",
        default: "GET",
      }),
    ),
    headers: Type.Optional(Type.Object({}, { title: "Headers", description: "请求头键值对对象，默认无" })),
    body: Type.Optional(
      Type.Object(
        {},
        {
          title: "Body",
          description: "请求体对象(自动 JSON 序列化并补充 content-type: application/json)，GET/HEAD 忽略",
        },
      ),
    ),
    params: Type.Optional(
      Type.Object(
        {},
        { title: "Params", description: "查询参数键值对对象，合并到 URL 查询串(URL 已有同名参数时覆盖)，默认无" },
      ),
    ),
    timeout: Type.Optional(
      Type.Integer({
        title: "Timeout",
        description: `单次请求超时毫秒数(${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS})，默认 ${DEFAULT_TIMEOUT_MS}`,
        default: DEFAULT_TIMEOUT_MS,
      }),
    ),
    retry: Type.Optional(
      Type.Integer({
        title: "Retry",
        description: `失败重试次数(0–${MAX_RETRIES})，仅网络异常/超时/5xx/429 触发，指数退避，默认 0`,
        default: 0,
      }),
    ),
    auth: Type.Optional(
      Type.Object(
        {
          type: Type.String({ description: "Basic: 'basic', Bearer: 'bearer'" }),
          username: Type.Optional(Type.String({ description: "Basic 用户名" })),
          password: Type.Optional(Type.String({ description: "Basic 密码" })),
          token: Type.Optional(Type.String({ description: "Bearer token" })),
        },
        {
          title: "Auth",
          description: "Basic: { type: 'basic', username, password }；Bearer: { type: 'bearer', token }",
        },
      ),
    ),
    maxBytes: Type.Optional(
      Type.Integer({ title: "MaxBytes", description: "响应体积上限(字节)，默认 1MB，硬上限 64MiB" }),
    ),
  }),
  run: (input, ctx) => runHttpRequest(input as unknown as Record<string, unknown>, ctx),
});

export default pack({ id: "http", tools: [http_request] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "http", tools: [http_request] }));
