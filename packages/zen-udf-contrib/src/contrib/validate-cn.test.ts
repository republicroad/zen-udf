import { describe, expect, test } from "vitest";

import { validateBankCard, validateIdCard, validateMobile, validateUscc } from "./validate-cn.ts";

/** 按校验算法反向合成：先生成 17 位，再补 MOD 11-2 校验码 */
const makeId = (prefix17: string): string => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const map = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = prefix17.split("").reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  return prefix17 + map[sum % 11];
};

const syntheticId = makeId("11010119900315123"); // 北京 1990-03-15 顺序码 1（男）
const syntheticIdFemale = makeId("11010119900315224");

describe("validate_id_card", () => {
  test("合成合法证号通过并解析字段", () => {
    const r = validateIdCard(syntheticId);
    expect(r.valid).toBe(true);
    expect((r as { fields?: Record<string, string> }).fields?.province).toBe("11");
    expect((r as { fields?: Record<string, string> }).fields?.birth).toBe("19900315");
    expect((r as { fields?: Record<string, string> }).fields?.sex).toBe("M");
  });

  test("女性顺序码", () => {
    const r = validateIdCard(syntheticIdFemale) as { valid?: boolean; fields?: Record<string, string> };
    expect(r.valid).toBe(true);
    expect(r.fields?.sex).toBe("F");
  });

  test.each([
    ["篡改校验位", `${syntheticId.slice(0, 17)}0`, "CHECKSUM_MISMATCH"],
    ["未知省码", makeId("99010119900315123"), "ADDR_CODE_UNKNOWN"],
    ["出生日期非法", makeId("11010119901315123"), "BIRTH_INVALID"],
    ["位数不足", "1101011990031", "FORMAT"],
  ])("%s", (_name, value, code) => {
    expect(validateIdCard(value)).toMatchObject({ valid: false, code });
  });
});

describe("validate_mobile", () => {
  test("合法号段", () => {
    expect(validateMobile("13800138000")).toMatchObject({ valid: true });
  });
  test.each(["12300138000", "1380013800", ""])("%s 非法", (value) => {
    expect(validateMobile(value).valid).toBe(false);
  });
});

describe("validate_uscc", () => {
  /** 反向合成：17 位前缀 + base-31 校验位 */
  const makeUscc = (prefix17: string): string => {
    const charset = "0123456789ABCDEFGHJKLMNPQRTUWXY";
    const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
    const sum = prefix17.split("").reduce((acc, ch, i) => acc + charset.indexOf(ch) * weights[i], 0);
    return prefix17 + charset[(31 - (sum % 31)) % 31];
  };

  test("合成合法代码通过", () => {
    expect(validateUscc(makeUscc("91110000123456789"))).toMatchObject({ valid: true });
  });
  test("含 I/O/S/V/Z 排除字符拒绝", () => {
    expect(validateUscc("91I10000123456789X").valid).toBe(false);
  });
});

describe("validate_bank_card", () => {
  test("Luhn 合法卡号（合成）", () => {
    // 79927398713 是 Luhn 教科书向量，补位到 13 位以上用前导 0 不影响 Luhn
    expect(validateBankCard("4111111111111111").valid).toBe(true);
  });
  test("去空格/连字符后校验", () => {
    expect(validateBankCard("4111 1111-1111 1111").valid).toBe(true);
  });
  test("数字篡改失败", () => {
    expect(validateBankCard("4111111111111112")).toMatchObject({ valid: false, code: "CHECKSUM_MISMATCH" });
  });
});
