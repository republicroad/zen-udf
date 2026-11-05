import { setPorts } from "@republicroad/zen-udf";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";


import { httpRequest } from "./http.ts";

let server: Server;
let baseUrl: string;
let servedBytes = 0;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  // 同 http.test.ts:防 apps/api 全局 egress 闸泄漏进单进程测试图
  setPorts({});
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const size = Number(url.searchParams.get("size") ?? 10);
      servedBytes += size;
      json(res, 200, { data: "x".repeat(size) });
    });
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

describe("BB4 http UDF maxBytes 守卫", () => {
  test("响应超 kwargs.maxBytes → 结构化失败且不重试", async () => {
    servedBytes = 0;
    const result = (await httpRequest({
      url: `${baseUrl}/?size=5000`,
      maxBytes: 1024,
      retry: 3,
    })) as { status: number; error?: string; policyBlocked?: boolean };
    expect(result.status).toBe(0);
    expect(result.error).toContain("maxBytes");
    expect(result.policyBlocked).toBe(true);
    // 策略性失败不重试：只服务了 1 次
    expect(servedBytes).toBe(5000);
  });

  test("kwargs.maxBytes 调大后正常返回", async () => {
    const result = (await httpRequest({
      url: `${baseUrl}/?size=5000`,
      maxBytes: 1024 * 1024,
    })) as { status: number; body?: { data?: string } };
    expect(result.status).toBe(200);
    expect(result.body?.data?.length).toBe(5000);
  });
});
