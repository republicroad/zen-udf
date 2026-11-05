import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @republicroad/zen-udf 硬指核源文件：workspace 符号链接 + vitest 4 的模块解析
// 会产生测试/被测双模块实例（getRateStore 单例双份，注入失效）——alias 钉死
// 单一文件路径保证单实例。
const coreEntry = fileURLToPath(new URL("../zen-udf/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@republicroad/zen-udf": coreEntry } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 模块级单例（rate-store activeStore / globalUdfRegistry）依赖文件级串行——
    // 并行文件互写单例是 counter 交错的根因
    fileParallelism: false,
    server: { deps: { inline: ["@republicroad/zen-udf"] } },
  },
});
