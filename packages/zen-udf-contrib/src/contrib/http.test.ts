import { globalUdfRegistry, setPorts } from "@republicroad/zen-udf";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";



import { httpRequest } from "./http.ts";

let server: Server;
let baseUrl: string;
let closedUrl: string;

/** /flaky 连续失败计数(每个用例开始前重置)；/missing 命中计数(用于断言 4xx 不重试) */
let flakyRemaining = 0;
let missingHits = 0;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => (data += chunk));
    req.on("end", () => resolve(data));
  });

beforeAll(async () => {
  // 根 bun test 单进程共享模块图:apps/api 测试会全局注入生产 egress 闸(实测拦截 127.0.0.1),
  // 本文件假设 ports 缺省空(单 workspace 进程语义),先自隔离
  setPorts({});
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/json") {
      json(res, 200, { ok: true, q: url.searchParams.get("q") });
      return;
    }
    if (url.pathname === "/params") {
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      json(res, 200, query);
      return;
    }
    if (url.pathname === "/echo") {
      const bodyText = await readBody(req);
      json(res, 200, {
        method: req.method,
        contentType: req.headers["content-type"] ?? null,
        authorization: req.headers["authorization"] ?? null,
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => json(res, 200, "late"), 500);
      return;
    }
    if (url.pathname === "/flaky") {
      if (flakyRemaining > 0) {
        flakyRemaining -= 1;
        res.writeHead(500);
        res.end("boom");
        return;
      }
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/missing") {
      missingHits += 1;
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.listen(0, "127.0.0.1", () => {
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  // closedUrl：起服后立即关闭，用于连接拒绝场景
  const throwaway = createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  closedUrl = `http://127.0.0.1:${(throwaway.address() as { port: number }).port}`;
  throwaway.close();
});

afterAll(() => {
  server.close();
});

const callUdf = async (kwargs: Record<string, unknown>) => (await httpRequest(kwargs)) as Record<string, unknown>;

describe("http_request udf", () => {
  test("GET 解析 JSON 响应体", async () => {
    const result = await callUdf({ url: `${baseUrl}/json?q=abc` });
    expect(result["status"]).toBe(200);
    expect(result["error"]).toBeUndefined();
    expect(result["body"]).toEqual({ ok: true, q: "abc" });
    const headers = result["headers"] as Record<string, string>;
    expect(headers["content-type"]).toContain("application/json");
  });

  test("POST 自动 JSON 序列化并补充 content-type", async () => {
    const result = await callUdf({ url: `${baseUrl}/echo`, method: "POST", body: { a: 1 } });
    expect(result["status"]).toBe(200);
    expect(result["body"]).toEqual({
      method: "POST",
      contentType: "application/json",
      authorization: null,
      body: { a: 1 },
    });
  });

  test("显式 content-type 不被覆盖，空对象视为无请求体", async () => {
    const withBody = await callUdf({
      url: `${baseUrl}/echo`,
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: { a: 1 },
    });
    expect((withBody["body"] as Record<string, unknown>)["contentType"]).toBe("text/plain");

    const emptyBody = await callUdf({ url: `${baseUrl}/echo`, method: "POST", body: {} });
    expect((emptyBody["body"] as Record<string, unknown>)["body"]).toBeNull();
  });

  test("GET/HEAD 忽略 body，非 2xx 正常返回", async () => {
    const getWithBody = await callUdf({ url: `${baseUrl}/echo`, body: { a: 1 } });
    expect(getWithBody["status"]).toBe(200);
    expect((getWithBody["body"] as Record<string, unknown>)["method"]).toBe("GET");
    expect((getWithBody["body"] as Record<string, unknown>)["body"]).toBeNull();

    const notFound = await callUdf({ url: `${baseUrl}/missing` });
    expect(notFound["status"]).toBe(404);
    expect(notFound["body"]).toBe("not found");
    expect(notFound["error"]).toBeUndefined();
  });

  test("连接拒绝返回结构化错误而非抛出", async () => {
    const result = await callUdf({ url: closedUrl });
    expect(result["status"]).toBe(0);
    expect(typeof result["error"]).toBe("string");
    expect(String(result["error"]).length).toBeGreaterThan(0);
  });

  test("非法 HTTP 方法被白名单拦截", async () => {
    const result = await callUdf({ url: `${baseUrl}/echo`, method: "TRACE" });
    expect(result["status"]).toBe(0);
    expect(result["error"]).toBe("unsupported http method 'TRACE'");
  });

  test("params 合并进 URL 查询串并覆盖同名参数", async () => {
    const result = await callUdf({
      url: `${baseUrl}/params?existing=keep&q=old`,
      params: { q: "new", page: "2" },
    });
    expect(result["status"]).toBe(200);
    expect(result["body"]).toEqual({ existing: "keep", q: "new", page: "2" });
  });

  test("basic 认证生成 Authorization 头，显式头优先于 auth 配置", async () => {
    const basic = await callUdf({
      url: `${baseUrl}/echo`,
      auth: { type: "basic", username: "alice", password: "s3cret" },
    });
    expect((basic["body"] as Record<string, unknown>)["authorization"]).toBe(
      `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`,
    );

    const overridden = await callUdf({
      url: `${baseUrl}/echo`,
      headers: { authorization: "Bearer manual" },
      auth: { type: "bearer", token: "auto" },
    });
    expect((overridden["body"] as Record<string, unknown>)["authorization"]).toBe("Bearer manual");

    const bearer = await callUdf({ url: `${baseUrl}/echo`, auth: { type: "bearer", token: "tk-1" } });
    expect((bearer["body"] as Record<string, unknown>)["authorization"]).toBe("Bearer tk-1");
  });

  test("timeout 超时返回结构化错误", async () => {
    const result = await callUdf({ url: `${baseUrl}/slow`, timeout: 100 });
    expect(result["status"]).toBe(0);
    expect(typeof result["error"]).toBe("string");
  });

  test("retry 仅对 5xx 重试直至成功，4xx 不重试", async () => {
    flakyRemaining = 2;
    const recovered = await callUdf({ url: `${baseUrl}/flaky`, retry: 2 });
    expect(recovered["status"]).toBe(200);
    expect(recovered["body"]).toEqual({ ok: true });

    flakyRemaining = 5;
    const exhausted = await callUdf({ url: `${baseUrl}/flaky`, retry: 1 });
    expect(exhausted["status"]).toBe(500);

    missingHits = 0;
    const notRetried = await callUdf({ url: `${baseUrl}/missing`, retry: 3 });
    expect(notRetried["status"]).toBe(404);
    expect(missingHits).toBe(1);
  });

  test("非法 URL 直接报错且不重试", async () => {
    const result = await callUdf({ url: "not-a-url", retry: 2 });
    expect(result["status"]).toBe(0);
    expect(String(result["error"])).toContain("invalid url");
  });

  test("引擎路径：funcBindParams 按声明顺序位置绑定，url 缺省参数回退默认值", async () => {
    const kwargs = globalUdfRegistry.funcBindParams("http_request", [`${baseUrl}/json`]);
    expect(Object.keys(kwargs)).toEqual([
      "url",
      "method",
      "headers",
      "body",
      "params",
      "timeout",
      "retry",
      "auth",
      "maxBytes",
    ]);
    expect(kwargs["method"]).toBe("GET");
    expect(kwargs["timeout"]).toBe(10000);
    expect(kwargs["retry"]).toBe(0);
    const result = (await globalUdfRegistry.call("http_request", kwargs)) as Record<string, unknown>;
    expect(result["status"]).toBe(200);
    expect(result["body"]).toEqual({ ok: true, q: null });
  });

  test("旧图兼容：仅前 4 个位置参数时新参数回退默认值并可正常执行", async () => {
    const kwargs = globalUdfRegistry.funcBindParams("http_request", [`${baseUrl}/json`, "POST", { x: "1" }, { a: 1 }]);
    expect(kwargs["params"]).toEqual({});
    expect(kwargs["auth"]).toEqual({});
    expect(kwargs["timeout"]).toBe(10000);
    expect(kwargs["retry"]).toBe(0);
    const result = (await globalUdfRegistry.call("http_request", kwargs)) as Record<string, unknown>;
    expect(result["status"]).toBe(200);
  });
});
