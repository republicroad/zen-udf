import { globalUdfRegistry } from "@republicroad/zen-udf";

import { describe, expect, test } from "vitest";


import "./crypto.ts";

const callCrypto = async (...args: unknown[]): Promise<string> => {
  const kwargs = globalUdfRegistry.funcBindParams("crypto", args);
  return (await globalUdfRegistry.call("crypto", kwargs)) as string;
};

describe("crypto UDF", () => {
  test("标准摘要向量(hex)", async () => {
    expect(await callCrypto("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await callCrypto("hello", "md5")).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(await callCrypto("hello", "sha1")).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(await callCrypto("hello", "sha512")).toBe(
      "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043",
    );
  });

  test("base64 与 base64url 编码", async () => {
    expect(await callCrypto("hello", "sha256", null, "base64")).toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
    expect(await callCrypto("hello", "sha256", null, "base64url")).toBe("LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
  });

  test("HMAC 模式(secret 非空启用)", async () => {
    const msg = "The quick brown fox jumps over the lazy dog";
    expect(await callCrypto(msg, "sha256", "key")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
    expect(await callCrypto(msg, "md5", "key")).toBe("80070713463e7749b90c2dc24911e275");
  });

  test("空 secret 为普通摘要，与带 secret 区分", async () => {
    expect(await callCrypto("hello", "sha256", "")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("非法算法/编码回退默认值，不抛异常", async () => {
    expect(await callCrypto("hello", "sm3")).toBe(await callCrypto("hello"));
    expect(await callCrypto("hello", "SHA256")).toBe(await callCrypto("hello"));
    expect(await callCrypto("hello", "sha256", null, "rot13")).toBe(await callCrypto("hello"));
  });

  test("upper 仅对 hex 生效", async () => {
    expect(await callCrypto("hello", "md5", null, "hex", true)).toBe("5D41402ABC4B2A76B9719D911017C592");
    const b64Upper = await callCrypto("hello", "sha256", null, "base64", true);
    expect(b64Upper).toBe(await callCrypto("hello", "sha256", null, "base64"));
  });

  test("引擎路径：funcBindParams 按声明顺序位置绑定，缺省参数回退默认值", () => {
    const kwargs = globalUdfRegistry.funcBindParams("crypto", ["hello"]);
    expect(Object.keys(kwargs)).toEqual(["input", "algorithm", "secret", "encoding", "upper"]);
    expect(kwargs["algorithm"]).toBe("sha256");
    expect(kwargs["encoding"]).toBe("hex");
    expect(kwargs["secret"]).toBe("");
    expect(kwargs["upper"]).toBe(false);
  });
});
