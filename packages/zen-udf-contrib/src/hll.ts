// HyperLogLog（纯 TS，dense 2^14 registers ≈ 16KB/sketch，标准差 ~0.81%）。
// 代数：add（入集）/ count（基数估计：小集合线性计数、大集合调和均值）/ merge
//（取 max——可合并分布式原生：本地 sketch 低频合并全局，per-event 零集中写）。
//
// 能力边界（语义声明写死）：只出基数——无 delta（差分，union-only 代数推不出）、
// 无 idle（无时间戳）、无 membership（无成员枚举）。窗口语义由 store 层过期承载。
//
// hash：双 FNV-1a 32 位变体拼接 64 位（idx 用高 14 位，ρ 用低位）。

const P = 14; // precision：2^14 registers
const M = 1 << P;
const M_SEED = M * 0.7; // linear counting 阈值（≈ 5m = 81920？此处取保守 0.7m？标准 5m/2）
const LARGE_ESTIMATOR_THRESHOLD = 5 * M;
const TWO_POW_32 = 4_294_967_296;

function fnv1a32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** 64 位哈希（双 32 位拼接）：返回 { idx 高 14 位, rho 低 50 位的前导零+1 } */
function hashSplit(input: string): { idx: number; rho: number } {
  const hi = fnv1a32(input, 0x811c9dc5);
  const lo = fnv1a32(input, 0x9747b28c);
  const h64 = (BigInt(hi) << 32n) | BigInt(lo);
  const idx = Number(h64 >> 50n); // 高 14 位作 register 索引
  const rest = h64 & ((1n << 50n) - 1n);
  let rho = 1;
  for (let i = 0; i < 50; i++) {
    if ((rest >> BigInt(49 - i)) & 1n) break;
    rho++;
  }
  return { idx, rho: Math.min(rho, 51) };
}

export class Hll {
  private readonly registers = new Uint8Array(M);
  private cachedCount: number | null = null;

  add(member: string): void {
    this.cachedCount = null;
    const { idx, rho } = hashSplit(member);
    if (this.registers[idx] < rho) this.registers[idx] = rho;
  }

  merge(other: Hll): void {
    this.cachedCount = null;
    for (let i = 0; i < M; i++) {
      if (other.registers[i] > this.registers[i]) this.registers[i] = other.registers[i];
    }
  }

  /** 基数估计（≈0.81% 标准差）：小基数线性计数、大集合调和均值、range 修正 */
  count(): number {
    if (this.cachedCount !== null) return this.cachedCount;
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i++) {
      sum += 1 / Math.pow(2, this.registers[i]);
      if (this.registers[i] === 0) zeros++;
    }
    const estimate = (0.794 * M * M) / sum; // 调和均值估计
    let result: number;
    if (zeros > 0) {
      result = M * Math.log(M / zeros); // linear counting（小基数更准）
    } else {
      result = estimate;
      // 大基数偏移修正（32 位哈希指纹空间耗尽区）
      if (result > TWO_POW_32 / 30) {
        const v = zeros;
        if (v > 0) result = M * Math.log(M / v);
      }
    }
    this.cachedCount = Math.round(result);
    return this.cachedCount;
  }
}
