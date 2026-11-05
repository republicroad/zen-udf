import { describe, expect, test } from "vitest";

import { currentDate } from "./debugui.ts";

describe("current_date udf", () => {
  test("返回 YYYY-MM-DD 格式日期", () => {
    const result = currentDate() as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
