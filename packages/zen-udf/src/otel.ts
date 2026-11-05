/**
 * OpenTelemetry 桥（Y6，可选）：宿主安装 @opentelemetry/api 即启用追踪，
 * 未安装时零依赖降级（动态 import 失败返回 undefined）。
 * 范围（Y6 最小面）：evaluate 根 span（含模型/租户/审计属性）+ UdfTrace 作为 span events；
 * customNode 子 span 需解决 TSFN 边界的 OTel context 重附着，暂缓。
 */

let apiPromise: Promise<any | undefined> | undefined;

/** 懒加载 @opentelemetry/api；未安装返回 undefined（幂等） */
export const loadOtelApi = async (): Promise<any | undefined> => {
  if (!apiPromise) {
    apiPromise = import("@opentelemetry/api").catch(() => undefined);
  }
  return apiPromise;
};

export interface OtelSpanOptions {
  attributes?: Record<string, unknown>;
  /** span 结束前回调（挂 UdfTrace 事件）；span 已 startActive，可 addEvent */
  onSpan?: (span: any) => void;
}

/** 在 OTel span 内执行（未安装 api 时直接执行）；异常自动 recordException + ERROR 状态 */
export async function withOtelSpan<T>(
  name: string,
  options: OtelSpanOptions,
  fn: (span: any | undefined) => Promise<T>,
): Promise<T> {
  const api: any = await loadOtelApi();
  if (!api?.trace?.getTracer) {
    return fn(undefined);
  }
  const tracer = api.trace.getTracer("zen-udf");
  const span = tracer.startSpan(name, { attributes: options.attributes });
  try {
    const result = await fn(span);
    span.setStatus({ code: api.SpanStatusCode.OK });
    return result;
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    span.end();
  }
}
