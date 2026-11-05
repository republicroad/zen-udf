import type { UdfPorts } from "@republicroad/zen-udf";
import { runWithExecContext, setPorts } from "@republicroad/zen-udf";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";




import { httpRequest } from "./http.ts";

let server: Server;
let baseUrl: string;
let echoHits = 0;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const call = async (kwargs: Record<string, unknown>, ctx?: { tenantId: string }): Promise<unknown> =>
  ctx ? runWithExecContext(ctx, async () => httpRequest(kwargs)) : httpRequest(kwargs);

beforeAll(async () => {
  setPorts({}); // 隔离其他测试文件经 setPorts 泄漏的端口状态
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      echoHits += 1;
      json(res, 200, { ok: true, auth: req.headers["authorization"] ?? null });
    });
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  setPorts({});
  server.close();
});

describe("http_request EgressGuard（U9）", () => {
  test("缺省无守卫时出口不受限", async () => {
    const result = (await call({ url: `${baseUrl}/json` })) as { status: number };
    expect(result.status).toBe(200);
  });

  test("egress 拒绝返回结构化错误且不重试", async () => {
    let guardCalls = 0;
    setPorts({
      egressGuard: {
        assertAllowed: (url) => {
          guardCalls += 1;
          if (!url.startsWith("https://api.allowed.example")) {
            throw new Error("host not in tenant allowlist");
          }
        },
      },
    } as UdfPorts);

    const result = (await call({ url: `${baseUrl}/json`, retry: 3 }, { tenantId: "t-1" })) as {
      status: number;
      error?: string;
      policyBlocked?: boolean;
    };
    expect(result.status).toBe(0);
    expect(result.error).toContain("egress blocked by policy");
    expect(result.error).toContain("allowlist");
    // 策略性失败不重试：守卫恰好被调用一次
    expect(guardCalls).toBe(1);
    setPorts({} as UdfPorts);
  });
});

describe("http_request SecretResolver（U9）", () => {
  test("basic 认证的 ${secret:引用} 按租户解析", async () => {
    setPorts({
      secretResolver: {
        resolve: (ref, tenantId) => (ref === "db-pass" && tenantId === "t-1" ? "s3cret-value" : ""),
      },
    } as UdfPorts);

    const result = (await call(
      { url: `${baseUrl}/echo`, auth: { type: "basic", username: "alice", password: "${secret:db-pass}" } },
      { tenantId: "t-1" },
    )) as { status: number; body?: { auth?: string } };
    expect(result.status).toBe(200);
    const expected = "Basic " + Buffer.from("alice:s3cret-value", "utf8").toString("base64");
    expect(result.body?.auth).toBe(expected);
    setPorts({} as UdfPorts);
  });

  test("未配置 resolver 时 secret 引用失败且不泄漏", async () => {
    echoHits = 0;
    const result = (await call({
      url: `${baseUrl}/echo`,
      retry: 2,
      auth: { type: "bearer", token: "${secret:missing-ref}" },
    })) as { status: number; error?: string; policyBlocked?: boolean };
    expect(result.status).toBe(0);
    expect(result.error).toContain("requires a configured secretResolver");
    expect(result.policyBlocked).toBe(true);
    // 策略性失败不重试
    expect(echoHits).toBe(0);
  });

  test("resolver 抛错时错误信息不包含已解析凭证", async () => {
    setPorts({
      secretResolver: {
        resolve: () => {
          throw new Error("secret db-pass not found for tenant");
        },
      },
    } as UdfPorts);
    const result = (await call(
      { url: `${baseUrl}/echo`, auth: { type: "basic", username: "u", password: "${secret:db-pass}" } },
      { tenantId: "t-1" },
    )) as { status: number; error?: string };
    expect(result.status).toBe(0);
    expect(result.error).toContain("secret resolve failed");
    expect(result.error).toContain("db-pass not found");
    setPorts({} as UdfPorts);
  });
});
