import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// crypto 域(摘要签名，有专属 UI 设计，文件名即 namespace)
//
// ADR-011 迁移：理想态 tool()/pack()。语义保持 query（纯摘要无副作用）。

import { createHash, createHmac } from "node:crypto";
import { Type } from "@sinclair/typebox";




const CRYPTO_ALGORITHMS = new Set(["md5", "sha1", "sha256", "sha512"]);
const CRYPTO_ENCODINGS = new Set(["hex", "base64", "base64url"]);

export const cryptoTool = tool({
  namespace: "crypto",
  name: "crypto",
  title: "crypto",
  description:
    "计算字符串摘要或 HMAC 签名，返回摘要字符串. algorithm 支持 md5/sha1/sha256/sha512(非法值回退 sha256)，" +
    "secret 非空时启用 HMAC 模式，encoding 支持 hex/base64/base64url(非法值回退 hex)，upper 仅对 hex 生效(大写输出).",
  semantics: "query",
  input: Type.Object({
    input: Type.String({ title: "Input", description: "待摘要内容" }),
    algorithm: Type.Optional(
      Type.String({
        title: "Algorithm",
        description: "摘要算法(md5/sha1/sha256/sha512)，默认 sha256，非法值回退 sha256",
        default: "sha256",
      }),
    ),
    secret: Type.Optional(
      Type.String({
        title: "Secret",
        description: "HMAC 密钥，非空启用 HMAC 模式，留空则为普通摘要",
        default: "",
      }),
    ),
    encoding: Type.Optional(
      Type.String({
        title: "Encoding",
        description: "输出编码(hex/base64/base64url)，默认 hex，非法值回退 hex",
        default: "hex",
      }),
    ),
    upper: Type.Optional(
      Type.Boolean({
        title: "Upper",
        description: "hex 输出转大写(仅 encoding=hex 时生效)，默认 false",
        default: false,
      }),
    ),
  }),
  output: Type.String({ title: "crypto 函数返回" }),
  run: (input) => {
    const content = String(input?.input ?? "");
    const algorithmRaw = String(input?.algorithm ?? "sha256")
      .trim()
      .toLowerCase();
    const algorithm = CRYPTO_ALGORITHMS.has(algorithmRaw) ? algorithmRaw : "sha256";
    const secret = String(input?.secret ?? "");
    const encodingRaw = String(input?.encoding ?? "hex")
      .trim()
      .toLowerCase();
    const encoding = CRYPTO_ENCODINGS.has(encodingRaw) ? encodingRaw : "hex";
    const upper = input?.upper === true;

    const algo = algorithm as "md5" | "sha1" | "sha256" | "sha512";
    const hasher = secret ? createHmac(algo, secret) : createHash(algo);
    hasher.update(content);
    const digest = hasher.digest(encoding as "hex" | "base64" | "base64url");
    return upper && encoding === "hex" ? digest.toUpperCase() : digest;
  },
});

export default pack({ id: "crypto", tools: [cryptoTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "crypto", tools: [cryptoTool] }));
