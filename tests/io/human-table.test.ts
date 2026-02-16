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
    expect(output).toContain("Review");
    expect(output).toContain("branch");
  });

  test("keeps non-wrap columns single-line on narrow widths", (): void => {
    const output = formatHumanTable(
      ["ID", "TITLE", "STATUS"],
      [["TASK-2026-000001", "This title should wrap on a narrow terminal width", "in_progress"]],
      { maxWidth: 30, wrapColumns: [1] },
    );

    const lines = output.split("\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(output).toContain("TASK-2026-000001");
    expect(output).toContain("in_progress");

    const dataLines = lines.slice(2);
    const wrappedTitleLines = dataLines
      .map((line) => line.split(" | "))
      .filter((parts) => parts.length === 3 && parts[0]?.trim() === "" && parts[2]?.trim() === "")
      .map((parts) => parts[1]?.trim() ?? "")
      .filter((value) => value.length > 0);

    expect(wrappedTitleLines.length).toBeGreaterThan(0);
  });

  test("does not wrap non-configured columns", (): void => {
    const output = formatHumanTable(
      ["ID", "TYPE", "SUMMARY"],
      [["a1b2c3d4", "feature_request", "Add export support for markdown notes from the timeline view"]],
      { maxWidth: 32, wrapColumns: [2] },
    );

    const rowLines = output.split("\n").slice(2);
    expect(rowLines[0]).toContain("a1b2c3d4");
    expect(rowLines[0]).toContain("feature_request");
    expect(rowLines.some((line) => line.includes("feature_request"))).toBe(true);
    expect(rowLines.filter((line) => line.includes("feature_request")).length).toBe(1);

    const wrappedSummaryLines = rowLines
      .map((line) => line.split(" | "))
      .filter((parts) => parts.length === 3 && parts[0]?.trim() === "" && parts[1]?.trim() === "")
      .map((parts) => parts[2]?.trim() ?? "")
      .filter((value) => value.length > 0);

    expect(wrappedSummaryLines.length).toBeGreaterThan(0);
  });
});
