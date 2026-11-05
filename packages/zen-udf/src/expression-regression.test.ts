import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { corpusFiles, kindOf, localZoneProbe, parseCsv, runCase } from "./expression-regression.runner.ts";

process.env.TZ = "UTC";

// 求值与比较语义在 runner 模块（台账再生脚本共用同一实现，单一事实源）

// import.meta.dir 是 bun 运行时专有；类型面局部收窄（消费方 tsc 不引入 bun-types）
const importMetaDir = (import.meta as { dir?: string }).dir ?? "src";

const LEDGER: {
  divergences: Record<string, string>;
  calibratedZoneProbe?: string;
} = JSON.parse(readFileSync(join(importMetaDir, "expression-regression.divergences.json"), "utf8"));

// 台账适用性按「求值层真实时区」门控（localZoneProbe 直接测 wasm/原生层的
// 裸日期渲染，免疫 JS 层 TZ 覆写——bun test 自身就把 JS 层设为 UTC，而
// Windows 求值层恒读 OS 时区，混合环境下 Date/Intl 均不可信）。当前环境
// ≠ 校准时区时条目两向停用：校准环境的「差异」在别处可能天然通过（如
// UTC CI 的六条，无需清账），也可能以新形态失败——后者以「台账外新回归」
// 硬拦（新环境的真缺口须在彼环境重新校准入账）。
const ledgerApplicable = LEDGER.calibratedZoneProbe === undefined || LEDGER.calibratedZoneProbe === localZoneProbe();
const DIVERGENCES: Record<string, string> = ledgerApplicable ? LEDGER.divergences : {};

for (const file of corpusFiles) {
  const kind = kindOf(file);
  const { rows, skipped } = parseCsv(file);

  describe(`zen-expression 回归语料（${file}：${rows.length} 例，跳过非 3 字段行 ${skipped}）`, () => {
    for (const row of rows) {
      test(`${row.expression}  ←  ${row.input || "(empty)"}`, () => {
        const { pass, detail } = runCase(kind, row);
        const knownDivergence = DIVERGENCES[row.expression];
        if (pass) {
          expect(knownDivergence, `${file}:${row.line} 差异已修——请从台账清除: ${row.expression}`).toBeUndefined();
          return;
        }
        expect(
          knownDivergence,
          `${file}:${row.line} 台账外新回归 [${detail}]；若为版本缺口请入 expression-regression.divergences.json`,
        ).toBeDefined();
      });
    }
  });
}
