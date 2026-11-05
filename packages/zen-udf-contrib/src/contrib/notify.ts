import { getExecContext, globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// notify 域(notify_webhook 函数):面向 IM 机器人的轻量出站通知。
// 与 http 域共享同一出口防护/密钥解析配置面(configureHttpUdf 单一入口)。
//
// ADR-011 迁移：理想态 tool()/pack()。语义 = act（向外部世界施加通知动作），
// idempotent: false（通知重发有业务风险）。
import { Type } from "@sinclair/typebox";




import { currentEgressPolicy, SECRET_REF_PATTERN } from "./http.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 200;
const MAX_MESSAGE_BYTES = 16 * 1024;

type Channel = "feishu" | "dingtalk" | "wecom" | "slack";

const CHANNELS: ReadonlySet<string> = new Set(["feishu", "dingtalk", "wecom", "slack"]);

const buildPayload = (channel: Channel, message: string, title?: string): Record<string, unknown> => {
  switch (channel) {
    case "feishu":
      return title
        ? { msg_type: "text", content: { text: `${title}\n${message}` } }
        : { msg_type: "text", content: { text: message } };
    case "dingtalk":
      return title
        ? { msgtype: "markdown", markdown: { title, text: message } }
        : { msgtype: "text", text: { content: message } };
    case "wecom":
      return title
        ? { msgtype: "markdown", markdown: { content: `**${title}**\n${message}` } }
        : { msgtype: "text", text: { content: message } };
    case "slack":
      return title ? { text: `*${title}*\n${message}` } : { text: message };
  }
};

const notifyErrorResult = (error: string) => ({ ok: false, status: 0, body: null, error });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const notifyWebhookTool = tool({
  namespace: "notify",
  name: "webhook",
  title: "notify_webhook",
  description:
    "向 IM 机器人 webhook 发送文本通知, 返回 { ok, status, body }. channel 支持 feishu/dingtalk/wecom/slack;" +
    "带 title 时按渠道转 markdown 形态. webhook 地址支持 `${secret:名称}` 引用(按租户解析, 群机器人地址含凭证, 推荐走密钥)," +
    "timeout/retry 语义与 http_request 一致(仅网络异常/超时/5xx/429 重试, 指数退避). ok 仅表示 HTTP 2xx;" +
    "部分平台(如钉钉)限流/错参仍回 200, 业务错误码在 body.errcode, 规则可按需检查. 失败返回结构化错误, 不抛出异常.",
  semantics: "act",
  idempotent: false,
  input: Type.Object({
    channel: Type.Optional(
      Type.String({
        title: "Channel",
        description: "通知渠道(feishu/dingtalk/wecom/slack), 决定 payload 形状, 默认 feishu",
        default: "feishu",
      }),
    ),
    webhook: Type.String({
      title: "Webhook URL",
      description: "机器人 webhook 地址, 支持 `${secret:名称}` 引用(推荐, 地址含凭证不应落图)",
    }),
    message: Type.String({ title: "Message", description: "通知正文(纯文本/markdown, ≤16KB)" }),
    title: Type.Optional(
      Type.String({
        title: "Title",
        description: "可选标题; 提供时 feishu 拼接首行, dingtalk/wecom/slack 转对应 markdown 形态",
        default: null,
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        title: "Timeout",
        description: `单次请求超时毫秒数(${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}), 默认 ${DEFAULT_TIMEOUT_MS}`,
        default: DEFAULT_TIMEOUT_MS,
      }),
    ),
    retry: Type.Optional(
      Type.Integer({
        title: "Retry",
        description: `失败重试次数(0–${MAX_RETRIES}), 仅网络异常/超时/5xx/429 触发, 指数退避, 默认 0`,
        default: 0,
      }),
    ),
  }),
  output: Type.Object({
    ok: Type.Boolean({ description: "HTTP 2xx 即 true; 平台业务错误码见 body" }),
    status: Type.Integer(),
    body: Type.Unknown({ description: "平台响应体(如钉钉 { errcode, errmsg })" }),
    error: Type.Optional(Type.String({ description: "失败原因(ok=false 时存在)" })),
  }),
  run: async (input, ctx) => {
    const channel = String(input?.channel ?? "feishu").trim();
    const rawWebhook = String(input?.webhook ?? "").trim();
    const message = String(input?.message ?? "");
    const title = input?.title == null ? undefined : String(input.title);

    if (!CHANNELS.has(channel)) {
      return notifyErrorResult(`unsupported channel '${channel}'`);
    }
    if (!message.trim()) {
      return notifyErrorResult("message is required");
    }
    if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
      return notifyErrorResult(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    if (!rawWebhook) {
      return notifyErrorResult("webhook is required");
    }

    const tenantId = getExecContext()?.tenantId;
    const { egressGuard, secretResolver } = currentEgressPolicy();
    let webhookUrl = rawWebhook;
    if (SECRET_REF_PATTERN.test(webhookUrl)) {
      if (!secretResolver) {
        return {
          ...notifyErrorResult("secret reference in webhook requires a configured secretResolver"),
          policyBlocked: true,
        };
      }
      try {
        webhookUrl = await secretResolver.resolve(webhookUrl.replace(SECRET_REF_PATTERN, "$1"), tenantId);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { ...notifyErrorResult("secret resolve failed: " + reason), policyBlocked: true };
      }
    }
    if (!/^https:\/\//.test(webhookUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(webhookUrl)) {
      return notifyErrorResult("webhook must be an https URL (http allowed only for loopback hosts)");
    }
    try {
      await egressGuard?.assertAllowed(webhookUrl, tenantId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ...notifyErrorResult("egress blocked by policy: " + reason), policyBlocked: true };
    }

    const payload = buildPayload(channel as Channel, message, title);
    const requestBody = JSON.stringify(payload);
    const retryCount = Number(input?.retry);
    const retries = Number.isFinite(retryCount) ? Math.min(Math.max(Math.trunc(retryCount), 0), MAX_RETRIES) : 0;
    const timeoutRaw = Number(input?.timeout);
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    const attemptOnce = async (): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> => {
      const controller = new AbortController();
      const signal =
        ctx?.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([controller.signal, ctx.signal])
          : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
          signal,
        });
        const responseText = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(responseText);
        } catch {
          body = responseText;
        }
        return { ok: response.status >= 200 && response.status < 300, status: response.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    };

    let result = await attemptOnce();
    for (
      let attempt = 1;
      attempt <= retries && (result.status === 0 || result.status === 429 || result.status >= 500);
      attempt += 1
    ) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      result = await attemptOnce();
    }
    if (!result.ok && result.error === undefined) {
      return { ...result, error: `webhook responded with status ${result.status}` };
    }
    return result;
  },
});

export const notifyWebhook = notifyWebhookTool.run;

export default pack({ id: "notify", tools: [notifyWebhookTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "notify", tools: [notifyWebhookTool] }));
