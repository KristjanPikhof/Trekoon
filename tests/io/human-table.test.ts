import { describe, expect, test } from "bun:test";

import { formatHumanTable } from "../../src/io/human-table";

describe("formatHumanTable", (): void => {
  test("renders a standard table", (): void => {
    const output = formatHumanTable(
      ["ID", "TITLE", "STATUS"],
      [["a1b2c3d4", "Short title", "todo"]],
      { maxWidth: 120, wrapColumns: [1] },
    );

    expect(output).toContain("ID");
    expect(output).toContain("TITLE");
    expect(output).toContain("Short title");
  });

  test("wraps long text into multiline rows", (): void => {
    const output = formatHumanTable(
      ["ID", "TITLE", "DESCRIPTION"],
      [
        [
          "0bcc31b2",
          "Review branch changes",
          "Review all commits and diffs in feature/image-upload-gitlab, provide feedback, and confirm merge readiness.",
        ],
      ],
      { maxWidth: 72, wrapColumns: [1, 2] },
    );

    const lines = output.split("\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(output).toContain("merge readiness.");
    expect(output).toContain("Review branch");
  });
});
