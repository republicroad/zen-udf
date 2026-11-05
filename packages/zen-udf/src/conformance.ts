/**
 * 端口 conformance 套件聚合出口（ADR-018，`@republicroad/zen-udf/conformance`）。
 *
 * 仅宿主测试代码消费——宿主经此入口运行端口实现的 conformance 套件，
 * 跑绿 = 接入许可（handoff §1「契约即测试」立法的可执行形态）。
 *
 * 本文件 MUST NOT 被 zen-udf 运行时入口（index.ts）引用——vitest 依赖
 * 仅限宿主测试环境，不进运行时依赖图（ADR-018 方案 B 的核心约束）。
 *
 * 后续端口的宿主实现 conformance（limiter/egress/secret）落同处归拢。
 */
export { rateStoreConformance } from "./rate-store-conformance.ts";
