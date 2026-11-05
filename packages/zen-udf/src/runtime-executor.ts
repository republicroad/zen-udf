import type { DecisionRuntime } from "./engine.ts";
import type { ExecContext } from "./exec-context.ts";
import { runWithExecContext } from "./exec-context.ts";
import type { DecisionFixture, DecisionTestExecutor } from "./fixtures.ts";

/** 夹具专用键命名空间：不碰宿主服务键空间（隔离修复，ADR-014 问题 4） */
const FIXTURES_KEY_PREFIX = "__fixtures__:";

/**
 * 服务端便利适配器：runtime 世界一行接入 executor 契约（ADR-014 附 A.3）。
 * 服务端面——与 runner 子路径（@republicroad/zen-udf/runner，零依赖）分离，
 * 浏览器消费走宿主自造 executor（ADR-014 包面注记）。
 */
export const createRuntimeExecutor = (
  runtime: DecisionRuntime,
  options: { key: string; model: string | object; rev?: string; tenantId?: string },
): DecisionTestExecutor => {
  const tenantId = options.tenantId ?? "fixtures";
  const rev = options.rev ?? "latest";
  const cacheKey = `${FIXTURES_KEY_PREFIX}${options.key}`;
  // promise memo：并发首跑只登记一次（闭包 boolean 有竞态窗口）
  let registration: Promise<void> | null = null;

  const ensureRegistered = (): Promise<void> => {
    registration ??= runWithExecContext({ tenantId }, async () => {
      try {
        runtime.createDecisionWithCacheKey(cacheKey, options.model, rev);
      } catch {
        runtime.updateDecisionWithCacheKey(cacheKey, options.model, rev);
      }
    });
    return registration;
  };

  return async (fixture: DecisionFixture) => {
    await ensureRegistered();
    const startedAt = Date.now();
    const execCtx: ExecContext = {
      tenantId,
      decisionId: `fixture:${fixture.name}`,
      ...(fixture.asOf ? { eventTime: fixture.asOf } : {}),
      ...(fixture.journal
        ? {
            replay: {
              decisionId: `fixture:${fixture.name}`,
              asOf: fixture.asOf ?? new Date().toISOString(),
              journal: fixture.journal,
            },
          }
        : {}),
    };
    // trace 开销是测试语义的一部分（traceHits 矩阵列）；与生产热路径的审计
    // 免 trace 化互不干扰（cbbbd347 解耦的是审计⇒trace，此处显式要 trace）
    const outcome = await runWithExecContext(execCtx, () =>
      runtime.evaluateAsync(cacheKey, fixture.input, { trace: true }, rev),
    );
    return {
      result: outcome.result,
      durationMs: Date.now() - startedAt,
      traceHits: Object.keys((outcome.trace ?? {}) as Record<string, unknown>),
    };
  };
};
