import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateExpressionSync, evaluateUnaryExpressionSync } from "@republicroad/zen-engine";
import JSON5 from "json5";

/**
 * zen-expression 回归语料的求值与比较语义——测试与台账再生脚本
 * （scripts-regression-scan.mjs）共用的单一事实源。
 */

// import.meta.dir 是 bun 运行时专有；类型面局部收窄（消费方 tsc 不引入 bun-types）
const importMetaDir = (import.meta as { dir?: string }).dir ?? "src";

export const DATA_DIR = join(importMetaDir, "expression-regression");

export type Row = { line: number; expression: string; input: string; output: string };
export type CaseKind = "standard" | "unary";
export type CaseResult = { pass: boolean; detail: string };

/**
 * 求值层的真实时区探针：裸日期经字符串拼接渲染出带偏移的 ISO 串
 * （`x2023-10-15T00:00:00+08:00` / UTC 环境 `...Z`）。这是唯一可信的
 * 时区观测位——JS 层（Date/Intl）会被 process.env.TZ 即时改写（bun 尤甚，
 * bun test 自身就把 TZ 设为 UTC），而 wasm/原生求值层 Windows 恒读 OS 时区、
 * POSIX 随 TZ env。分歧台账的适用性门控据此比对校准戳记。
 */
export const localZoneProbe = (): string | null => {
  try {
    const rendered = evaluateExpressionSync(`'x' + d('2023-10-15')`, {});
    const match = /([+-]\d{2}:\d{2}|Z)$/.exec(String(rendered));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

/** RFC 风格 ';' 分割：双引号包裹字段（"" 转义），非引号字段内引号按字面量 */
export const splitCsvLine = (raw: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' && current.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ";") {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
};

export const parseCsv = (file: string): { rows: Row[]; skipped: number } => {
  const rows: Row[] = [];
  let skipped = 0;
  const lines = readFileSync(join(DATA_DIR, file), "utf8").split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (index === 0 && raw.startsWith("expression (string)")) {
      return; // header（官方 has_headers）
    }
    const fields = splitCsvLine(raw);
    if (fields.length !== 3) {
      skipped++; // 官方 flexible 错误静默跳过（如 interval-iterator 2 字段行）
      return;
    }
    const [expression = "", input = "", output = ""] = fields;
    if (expression.trim().startsWith("#")) {
      return;
    }
    rows.push({ line: index + 1, expression: expression.trim(), input: input.trim(), output: output.trim() });
  });
  return { rows, skipped };
};

/** 键序不敏感深比较 + 数值容差 */
const looseEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") {
    return Object.is(a, b) || Math.abs(a - b) < 1e-9;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => looseEqual(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every(
        (k, i) => k === kb[i] && looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;
/**
 * ISO 日期时间串的时区容错比较（双通道，任一成立即等）：
 * ① 时刻相等——带 zone 的串按绝对时间比（引擎把 Z 输入换算为本地表示时放行）；
 * ② 墙钟相等——裸日期绑定的 zone 语义随环境（Windows napi 走 OS 时区，TZ env 无效），
 *    按 zone 前分量比（日/时/分/秒算错仍拦截）。
 */
const instantOf = (value: unknown): number | null => {
  if (typeof value !== "string" || !ISO_DATETIME.test(value) || !ISO_ZONED.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};
const wallClockOf = (value: unknown): string | null => {
  if (typeof value !== "string" || !ISO_DATETIME.test(value)) {
    return null;
  }
  return value.slice(0, 19).replace("T", " ");
};

export const compare = (actual: unknown, expected: unknown): boolean => {
  if (looseEqual(actual, expected)) {
    return true;
  }
  // 双通道「任一相等即等」：瞬时通道失败时仍可落墙钟通道（裸日期绑定的 zone 差异）
  const aInstant = instantOf(actual);
  const eInstant = typeof expected === "string" ? instantOf(expected) : null;
  if (aInstant !== null && eInstant !== null && aInstant === eInstant) {
    return true;
  }
  const aWall = wallClockOf(actual);
  const eWall = typeof expected === "string" ? wallClockOf(expected) : null;
  if (aWall !== null && eWall !== null && aWall === eWall) {
    return true;
  }
  return false;
};

export const runCase = (kind: CaseKind, row: Row): CaseResult => {
  try {
    const input = row.input ? JSON5.parse(row.input) : {};
    const actual =
      kind === "unary"
        ? evaluateUnaryExpressionSync(row.expression, input)
        : evaluateExpressionSync(row.expression, input);
    const expected = JSON5.parse(row.output);
    if (compare(actual, expected)) {
      return { pass: true, detail: "" };
    }
    return {
      pass: false,
      detail: `got=${JSON.stringify(actual) ?? String(actual)} want=${row.output}`,
    };
  } catch (error) {
    return { pass: false, detail: `threw: ${(error as Error).message.slice(0, 140)}` };
  }
};

export const corpusFiles = ["standard.csv", "date.csv", "unary.csv"] as const;
export const kindOf = (file: string): CaseKind => (file === "unary.csv" ? "unary" : "standard");
