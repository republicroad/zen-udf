import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

// template 域(template_render 函数)：Mustache 无逻辑子集渲染。
// 限制：禁 partials；模板 ≤16KB、输出 ≤64KB（防租户图内容 DoS）。
//
// ADR-011 迁移：理想态 tool()/pack()。templateRender 裸函数保留导出（测试签名不变）。
import { Type } from "@sinclair/typebox";




const MAX_TEMPLATE_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const err = (error: string) => ({ rendered: null, error });

/** 点路径取值（a.b.c），缺失返回 undefined */
const lookup = (path: string, context: Record<string, unknown>): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
      context,
    );

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 渲染 {{name}}/{{{raw}}}/{{#sec}}...{{/sec}}/{{^inv}}...{{/inv}}/{{!comment}}；禁 partials。栈式解析 */
const renderString = (template: string, context: Record<string, unknown>): string => {
  const tokens = template.split(/(\{\{\{[^{}]+\}\}\}|\{\{![^}]*\}\}|\{\{[#/^][^{}]*\}\}|\{\{[^{}]+\}\})/g);
  const root: string[] = [];
  const stack: Array<{ kind: "#" | "^"; key: string; parts: string[] }> = [];
  const top = (): string[] => (stack.length > 0 ? stack[stack.length - 1].parts : root);

  for (const token of tokens) {
    if (!token) continue;
    const open = /^\{\{([#^])(.+?)\}\}$/.exec(token);
    const close = /^\{\{\/(.+?)\}\}$/.exec(token);
    const raw = /^\{\{\{(.+)\}\}\}$/.exec(token);
    const comment = /^\{\{!.+\}\}$/.exec(token);
    if (open) {
      stack.push({ kind: open[1] as "#" | "^", key: open[2].trim(), parts: [] });
      continue;
    }
    if (close) {
      const key = close[1].trim();
      const frame = stack.pop();
      if (!frame || frame.key !== key) throw new Error(`unexpected close {{/${key}}}`);
      const value = lookup(frame.key, context);
      const truthy = frame.kind === "#" ? !!value : !value;
      if (truthy) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          const inner =
            item && typeof item === "object"
              ? { ...context, ...(item as Record<string, unknown>), ".": item }
              : context;
          top().push(renderString(frame.parts.join(""), inner));
        }
      }
      continue;
    }
    if (comment) continue;
    if (raw) {
      // 段内延迟渲染（递归时用 item 上下文）；根层立即求值
      top().push(stack.length > 0 ? token : String(lookup(raw[1].trim(), context) ?? ""));
      continue;
    }
    if (/^\{\{/.test(token)) {
      const key = token.slice(2, -2).trim();
      if (key.startsWith(">")) throw new Error("partials are not supported");
      if (stack.length > 0) {
        top().push(token); // 延迟到递归
        continue;
      }
      const value = lookup(key, context);
      top().push(escapeHtml(value == null ? "" : String(value)));
      continue;
    }
    top().push(token);
  }
  if (stack.length > 0) throw new Error(`unclosed section {{#${stack[stack.length - 1].key}}}`);
  return root.join("");
};

/** 裸函数形态（kwargs 签名）：测试与纯函数消费方沿用 */
export const templateRender = (kwargs: Record<string, unknown>) => {
  const template = String(kwargs?.template ?? "");
  const context = kwargs?.context;
  if (Buffer.byteLength(template, "utf8") > MAX_TEMPLATE_BYTES) return err("TEMPLATE_TOO_LARGE");
  if (!context || typeof context !== "object" || Array.isArray(context)) return err("CONTEXT_NOT_OBJECT");
  try {
    const rendered = renderString(template, context as Record<string, unknown>);
    if (Buffer.byteLength(rendered, "utf8") > MAX_OUTPUT_BYTES) return err("OUTPUT_OVERFLOW");
    return { rendered, error: undefined };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
};

export const templateRenderTool = tool({
  namespace: "template",
  name: "render",
  description:
    "Mustache 无逻辑子集渲染：{{name}}（HTML 转义）、{{{raw}}}（不转义）、{{#sec}}...{{/sec}}（列表/真值）、" +
    "{{^inv}}（反转）、{{!注释}}。缺 key 输出空串。禁 partials。模板 ≤16KB、输出 ≤64KB，" +
    "结构化错误（TEMPLATE_TOO_LARGE / OUTPUT_OVERFLOW / RENDER_ERROR）。" +
    "渲染文本不渲染 JSON——结构化 payload 请在图内构造对象。",
  semantics: "query",
  input: Type.Object({
    template: Type.String({ title: "Template", description: "Mustache 模板（≤16KB）" }),
    context: Type.Record(Type.String(), Type.Unknown(), { title: "Context", description: "渲染数据对象" }),
  }),
  output: Type.Object({
    rendered: Type.Union([Type.String(), Type.Null()]),
    error: Type.Optional(Type.String()),
  }),
  run: (input) => templateRender({ template: String(input?.template ?? ""), context: input?.context }),
});

export default pack({ id: "template", tools: [templateRenderTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "template", tools: [templateRenderTool] }));
