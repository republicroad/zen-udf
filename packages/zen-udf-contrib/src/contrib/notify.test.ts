import type { UdfPorts } from "@republicroad/zen-udf";
import { setPorts } from "@republicroad/zen-udf";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";



import { notifyWebhook } from "./notify.ts";

let server: Server;
let baseUrl: string;

/** 命中的 webhook 路径 → 请求体与响应形态(每条用例前重置) */
const hits: Array<{ path: string; body: unknown }> = [];
let respond: (req: IncomingMessage, res: ServerResponse, url: URL) => void = (_req, res, _url) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let data = "";
    req.on("data", (chunk: Buffer | string) => (data += chunk));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(data);
      } catch {
        body = data;
      }
      hits.push({ path: url.pathname, body });
      respond(req, res, url);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  hits.length = 0;
  // 每条用例回到"无守卫、无密钥"开发态基线
  setPorts({} as UdfPorts);
  respond = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  };
});

describe("notify_webhook 渠道 payload 形状", () => {
  test.each([
    ["feishu", { msg_type: "text", content: { text: "hello" } }],
    ["dingtalk", { msgtype: "text", text: { content: "hello" } }],
    ["wecom", { msgtype: "text", text: { content: "hello" } }],
    ["slack", { text: "hello" }],
  ])("%s 文本消息", async (channel, expected) => {
    const result = (await notifyWebhook({ channel, webhook: `${baseUrl}/hook`, message: "hello" })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toEqual(expected);
  });

  test("带 title 时各渠道转 markdown/拼接形态", async () => {
    await notifyWebhook({ channel: "feishu", webhook: `${baseUrl}/hook`, message: "m", title: "T" });
    await notifyWebhook({ channel: "dingtalk", webhook: `${baseUrl}/hook`, message: "m", title: "T" });
    await notifyWebhook({ channel: "slack", webhook: `${baseUrl}/hook`, message: "m", title: "T" });
    expect(hits[0].body).toEqual({ msg_type: "text", content: { text: "T\nm" } });
    expect(hits[1].body).toEqual({ msgtype: "markdown", markdown: { title: "T", text: "m" } });
    expect(hits[2].body).toEqual({ text: "*T*\nm" });
  });

  test("非法渠道结构化报错且不出网", async () => {
    const result = (await notifyWebhook({ channel: "sms", webhook: `${baseUrl}/hook`, message: "hi" })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsupported channel");
    expect(hits).toHaveLength(0);
  });
});

describe("notify_webhook 结果语义", () => {
  test("HTTP 200 但平台业务错误码(body)原样透传, ok 仍为 true", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 310000, errmsg: "keywords not in content" }));
    };
    const result = (await notifyWebhook({ channel: "dingtalk", webhook: `${baseUrl}/hook`, message: "x" })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect((result.body as Record<string, unknown>).errcode).toBe(310000);
  });

  test("5xx: ok=false + error, retry 生效", async () => {
    let tries = 0;
    respond = (_req, res) => {
      tries += 1;
      res.writeHead(500);
      res.end();
    };
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: `${baseUrl}/hook`,
      message: "x",
      retry: 2,
      timeout: 300,
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("status 500");
    expect(tries).toBe(3);
  });
});

describe("notify_webhook 出口纪律", () => {
  test("webhook 支持 ${secret:引用} 且经密钥解析出真实地址", async () => {
    setPorts({ secretResolver: { resolve: async (ref) => `${baseUrl}/${ref}` } } as UdfPorts);
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: "${secret:feishu-bot}",
      message: "hi",
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(hits[0].path).toBe("/feishu-bot");
  });

  test("secret 引用但未配置 resolver: policyBlocked 不出网", async () => {
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: "${secret:feishu-bot}",
      message: "hi",
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.policyBlocked).toBe(true);
    expect(hits).toHaveLength(0);
  });

  test("EgressGuard 拒绝: policyBlocked 不出网", async () => {
    setPorts({
      egressGuard: {
        assertAllowed: () => {
          throw new Error("tenant egress deny");
        },
      },
    } as UdfPorts);
    const result = (await notifyWebhook({ channel: "feishu", webhook: `${baseUrl}/hook`, message: "hi" })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("egress blocked");
    expect(result.policyBlocked).toBe(true);
    expect(hits).toHaveLength(0);
  });

  test("公网明文 http webhook 拒绝(loopback 豁免)", async () => {
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: "http://example.com/hook",
      message: "hi",
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("https");
    expect(hits).toHaveLength(0);
  });
});

describe("notify_webhook 入参防御", () => {
  test("空 message 拒绝", async () => {
    const result = (await notifyWebhook({ channel: "feishu", webhook: `${baseUrl}/hook`, message: "  " })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("message is required");
  });

  test("超长 message 拒绝(>16KB)", async () => {
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: `${baseUrl}/hook`,
      message: "a".repeat(17 * 1024),
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bytes");
  });

  test("超时返回结构化错误不挂起", async () => {
    respond = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("{}");
      }, 2_000);
    };
    const result = (await notifyWebhook({
      channel: "feishu",
      webhook: `${baseUrl}/hook`,
      message: "hi",
      timeout: 100,
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});
