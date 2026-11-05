import { describe, expect, test } from "vitest";

import { templateRender } from "./template.ts";

describe("template_render", () => {
  test("插值 + 缺 key 空串 + HTML 转义", () => {
    expect(templateRender({ template: "{{user.name}}", context: { user: { name: "张三" } } }).rendered).toBe("张三");
    expect(templateRender({ template: "{{missing}}|", context: {} }).rendered).toBe("|");
    expect(templateRender({ template: "{{v}}", context: { v: "<b>" } }).rendered).toBe("&lt;b&gt;");
  });

  test("{{{raw}}} 不转义；{{!注释}} 消失", () => {
    expect(templateRender({ template: "{{{v}}}", context: { v: "<b>" } }).rendered).toBe("<b>");
    expect(templateRender({ template: "a{{! note }}b", context: {} }).rendered).toBe("ab");
  });

  test("sections：真值渲染、列表逐项、反转", () => {
    expect(templateRender({ template: "{{#on}}Y{{/on}}{{^on}}N{{/on}}", context: { on: true } }).rendered).toBe("Y");
    expect(
      templateRender({ template: "{{#list}}{{n}}{{/list}}", context: { list: [{ n: "a" }, { n: "b" }] } }).rendered,
    ).toBe("ab");
    expect(templateRender({ template: "{{#x}}Y{{/x}}{{^x}}N{{/x}}", context: {} }).rendered).toBe("N");
  });

  test("未闭合 section → RENDER_ERROR；模板超限 → TEMPLATE_TOO_LARGE", () => {
    expect(templateRender({ template: "{{#x}}unclosed", context: {} }).error).toContain("unclosed");
    expect(templateRender({ template: "a".repeat(17 * 1024), context: {} }).error).toBe("TEMPLATE_TOO_LARGE");
  });

  test("输出超限 → OUTPUT_OVERFLOW；context 非对象 → CONTEXT_NOT_OBJECT", () => {
    expect(templateRender({ template: "{{v}}", context: { v: "a".repeat(65 * 1024) } }).error).toBe("OUTPUT_OVERFLOW");
    expect(templateRender({ template: "x", context: "nope" as never }).error).toBe("CONTEXT_NOT_OBJECT");
  });
});
