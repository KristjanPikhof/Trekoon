import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { escapeHtml } from "../../src/board/assets/state/utils.js";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  test("escapes double-quote", () => {
    expect(escapeHtml('"value"')).toBe("&quot;value&quot;");
  });

  test("escapes single-quote (apostrophe)", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  test("escapes all five HTML-significant chars together", () => {
    expect(escapeHtml(`<div class="x" data-val='y'>a&b</div>`)).toBe(
      "&lt;div class=&quot;x&quot; data-val=&#39;y&#39;&gt;a&amp;b&lt;/div&gt;",
    );
  });

  test("coerces non-string values to string", () => {
    expect(escapeHtml(42 as unknown as string)).toBe("42");
  });

  test("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});
