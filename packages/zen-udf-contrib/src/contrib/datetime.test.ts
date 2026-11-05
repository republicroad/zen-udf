import { describe, expect, test } from "vitest";

import { dtBusinessDayTool, dtConvertTool, dtDiffTool } from "./datetime.ts";

describe("dt_convert", () => {
  test("时区转换（北京早晨 → 纽约前一晚）", () => {
    const r = dtConvertTool.run({ datetime: "2026-10-01T08:00:00+08:00", to: "America/New_York" }) as {
      datetime: string;
    };
    expect(r.datetime).toBe("2026-09-30T20:00:00");
  });
  test("非法时区/日期结构化报错", () => {
    // 工具无显式 output schema（Static 推导为 unknown）：错误面按结构化约定断言
    const run = (input: { datetime: string; to: string }) => dtConvertTool.run(input) as { error?: string };
    expect(run({ datetime: "x", to: "Asia/Shanghai" }).error).toBe("INVALID_DATE");
    expect(run({ datetime: "2026-10-01T08:00:00Z", to: "Nope/Nowhere" }).error).toBe("INVALID_TIMEZONE");
  });
});

/** 2026 春节示例表：假日 2/15–2/21，补班 2/7（六）与 2/28（六） */
const CAL = {
  holidays: ["2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21"],
  workdays: ["2026-02-07", "2026-02-28"],
};

describe("dt_business_day", () => {
  test("判定优先级：假日 > 补班 > 周末", () => {
    expect(dtBusinessDayTool.run({ date: "2026-02-16", op: "is_business_day", calendar: CAL })).toMatchObject({
      business: false,
    });
    expect(dtBusinessDayTool.run({ date: "2026-02-07", op: "is_business_day", calendar: CAL })).toMatchObject({
      business: true,
    });
    expect(dtBusinessDayTool.run({ date: "2026-02-08", op: "is_business_day", calendar: CAL })).toMatchObject({
      business: false,
    });
    expect(dtBusinessDayTool.run({ date: "2026-02-09", op: "is_business_day", calendar: CAL })).toMatchObject({
      business: true,
    });
  });

  test("add_business_days 跳过假日", () => {
    expect(
      dtBusinessDayTool.run({ date: "2026-02-06", op: "add_business_days", days: 1, calendar: CAL }),
    ).toMatchObject({
      date: "2026-02-07",
    }); // 2/7 补班
  });

  test("next_business_day", () => {
    expect(dtBusinessDayTool.run({ date: "2026-02-13", op: "next_business_day", calendar: CAL })).toMatchObject({
      date: "2026-02-23",
    }); // 跳过春节假期
  });
});

describe("dt_diff", () => {
  test("days / business_days / months", () => {
    expect(dtDiffTool.run({ from: "2026-01-31", to: "2026-03-01", unit: "days" })).toMatchObject({ count: 29 });
    expect(dtDiffTool.run({ from: "2026-01-31", to: "2026-03-01", unit: "months" })).toMatchObject({ count: 1 });
    const r = dtDiffTool.run({ from: "2026-02-09", to: "2026-02-13", unit: "business_days", calendar: CAL }) as {
      count: number;
    };
    expect(r.count).toBeGreaterThanOrEqual(4);
  });

  test("months=anniversary 完整月数（2026-10-01 宿主终裁，对齐内建 .diff(x,'M')）", () => {
    // 月末钳制视为满月（金融 EOM 惯例）：旧口径「月序差−日不足调减」给 2，现对齐内建给 3
    expect(dtDiffTool.run({ from: "2025-11-30", to: "2026-02-28", unit: "months" })).toMatchObject({ count: 3 });
    // 非月末的日不足仍减一（anniversary 语义本身）
    expect(dtDiffTool.run({ from: "2026-01-15", to: "2026-03-01", unit: "months" })).toMatchObject({ count: 1 });
    // 整月边界
    expect(dtDiffTool.run({ from: "2026-01-01", to: "2026-02-01", unit: "months" })).toMatchObject({ count: 1 });
    // 同月内为 0；钳制月与非钳制月一致（3-31→4-30 = 1）
    expect(dtDiffTool.run({ from: "2026-03-01", to: "2026-03-28", unit: "months" })).toMatchObject({ count: 0 });
    expect(dtDiffTool.run({ from: "2026-01-31", to: "2026-04-30", unit: "months" })).toMatchObject({ count: 3 });
  });
});
