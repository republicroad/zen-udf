import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// validate 域：中国常见证件/标识的本地校验。纯函数、零出网、零状态。
// 测试向量一律按校验算法反向合成，严禁使用真实公民证件号。
import { Type } from "@sinclair/typebox";




const CN_PROVINCES = new Set([
  "11",
  "12",
  "13",
  "14",
  "15",
  "21",
  "22",
  "23",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "50",
  "51",
  "52",
  "53",
  "54",
  "61",
  "62",
  "63",
  "64",
  "65",
]);
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_MAP = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];

const idChecksum = (first17: string): string => {
  const sum = first17.split("").reduce((acc, digit, i) => acc + Number(digit) * ID_WEIGHTS[i], 0);
  return ID_CHECK_MAP[sum % 11];
};

/** 18 位身份证校验：格式 → 地址码 → 出生日期 → MOD 11-2 校验码；返回解析字段 */
export const validateIdCard = (
  raw: string,
): { valid: boolean; code?: string; normalized?: string; fields?: Record<string, string> } => {
  const id = raw.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return { valid: false, code: "FORMAT" };
  if (!CN_PROVINCES.has(id.slice(0, 2))) return { valid: false, code: "ADDR_CODE_UNKNOWN" };
  const birth = id.slice(6, 14);
  const birthIso = `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}`;
  const date = new Date(birthIso);
  const today = new Date().toISOString().slice(0, 10);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== birthIso ||
    birthIso < "1900-01-01" ||
    birthIso > today
  ) {
    return { valid: false, code: "BIRTH_INVALID" };
  }
  if (idChecksum(id.slice(0, 17)) !== id[17]) return { valid: false, code: "CHECKSUM_MISMATCH" };
  return {
    valid: true,
    normalized: id,
    fields: { province: id.slice(0, 2), birth, sex: Number(id[16]) % 2 === 1 ? "M" : "F" },
  };
};

const mobileOk = (value: string): boolean => /^1[3-9]\d{9}$/.test(value);

export const validateMobile = (raw: string): { valid: boolean; normalized: string } => {
  const value = raw.trim();
  return { valid: mobileOk(value), normalized: value };
};

const USCC_CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** 统一社会信用代码（GB 32100-2015）：base-31 加权校验 */
export const validateUscc = (raw: string): { valid: boolean; code?: string } => {
  const code = raw.trim().toUpperCase();
  if (!/^[0-9A-HJ-NP-RTUWXY]{18}$/.test(code)) return { valid: false, code: "FORMAT" };
  const sum = code
    .slice(0, 17)
    .split("")
    .reduce((acc, ch, i) => acc + USCC_CHARSET.indexOf(ch) * USCC_WEIGHTS[i], 0);
  const check = USCC_CHARSET[(31 - (sum % 31)) % 31];
  return check === code[17] ? { valid: true } : { valid: false, code: "CHECKSUM_MISMATCH" };
};

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

export const validateBankCard = (raw: string): { valid: boolean; normalized: string; code?: string } => {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return { valid: false, normalized: digits, code: "FORMAT" };
  const ok = luhn(digits);
  return { valid: ok, normalized: digits, code: ok ? undefined : "CHECKSUM_MISMATCH" };
};

// ADR-011 迁移：理想态 tool() 声明（校验函数本体不动，测试直接消费导出的校验函数）
const valueTool = (name: string, description: string, run: (value: string) => unknown) =>
  tool({
    namespace: "validate",
    name,
    title: `validate_${name}`,
    description,
    semantics: "query",
    input: Type.Object({ value: Type.String({ description: "待校验值" }) }),
    run: (input) => run(input.value),
  });

export const validate_id_card = valueTool(
  "id_card",
  "校验 18 位中国居民身份证：格式、省级行政区码、出生日期合法性、MOD 11-2 校验码。" +
    "返回 { valid, fields: { province, birth, sex }, normalized }；失败返回 { valid: false, code }。",
  (value) => validateIdCard(String(value)),
);

export const validate_mobile = valueTool(
  "mobile",
  "校验中国大陆手机号格式（^1[3-9]\\d{9}$）。返回 { valid, normalized }。",
  (value) => validateMobile(String(value)),
);

export const validate_uscc = valueTool(
  "uscc",
  "校验 18 位统一社会信用代码（GB 32100-2015 base-31 加权校验）。返回 { valid, code? }。",
  (value) => validateUscc(String(value)),
);

export const validate_bank_card = valueTool(
  "bank_card",
  "校验银行卡号（Luhn 算法，13–19 位，自动去空格/连字符）。返回 { valid, normalized, code? }。",
  (value) => validateBankCard(String(value)),
);

export const tools = [validate_id_card, validate_mobile, validate_uscc, validate_bank_card];

export default pack({ id: "validate", tools });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "validate", tools }));
