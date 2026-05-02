import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES } from "../../src/domain/types.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const MACHINE_CONTRACTS_PATH = join(PROJECT_ROOT, "docs/machine-contracts.md");
const SRC_DIR = join(PROJECT_ROOT, "src");

/**
 * Parse documented error codes from docs/machine-contracts.md.
 * Only reads codes from the first column of the "Error code registry" table.
 * Table rows have the form: | `code_name` | Description text |
 */
function parseDocumentedCodes(contents: string): Set<string> {
  const codes = new Set<string>();
  const registryMatch = contents.match(/## Error code registry[\s\S]*?(?=\n## |$)/);
  if (!registryMatch) {
    throw new Error("Could not find '## Error code registry' section in docs/machine-contracts.md");
  }
  const section = registryMatch[0];
  // Match table rows: | `code_name` | ... |
  // Only capture the first backtick-quoted token on each line (the code column).
  const rowPattern = /^\|\s*`([a-z][a-z_]+)`\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(section)) !== null) {
    // match[1] is always a string here because the group is required in the pattern
    codes.add(match[1]!);
  }
  return codes;
}

/**
 * Scan src/** /*.ts files for error code string literals used in code: "..." patterns.
 * Returns the set of all unique code values found.
 */
function scanSourceCodes(): Set<string> {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const codes = new Set<string>();
  const codePattern = /\bcode:\s*["']([a-z][a-z_]+)["']/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        const text = readFileSync(full, "utf8");
        let match: RegExpExecArray | null;
        while ((match = codePattern.exec(text)) !== null) {
          codes.add(match[1]);
        }
        codePattern.lastIndex = 0;
      }
    }
  }

  walk(SRC_DIR);
  return codes;
}

describe("Error code contract", () => {
  const contractContents = readFileSync(MACHINE_CONTRACTS_PATH, "utf8");
  const documentedCodes = parseDocumentedCodes(contractContents);
  const registeredCodes = new Set(Object.values(ERROR_CODES));

  it("ERROR_CODES covers every code documented in machine-contracts.md", () => {
    const undocumentedInCode: string[] = [];
    for (const code of documentedCodes) {
      if (!registeredCodes.has(code as never)) {
        undocumentedInCode.push(code);
      }
    }
    expect(undocumentedInCode).toEqual([]);
  });

  it("machine-contracts.md documents every code in ERROR_CODES", () => {
    const missingFromDocs: string[] = [];
    for (const code of registeredCodes) {
      if (!documentedCodes.has(code)) {
        missingFromDocs.push(code);
      }
    }
    expect(missingFromDocs).toEqual([]);
  });

  it("every code literal in src matches a value in ERROR_CODES", () => {
    const sourceCodes = scanSourceCodes();
    const unknown: string[] = [];
    for (const code of sourceCodes) {
      if (!registeredCodes.has(code as never)) {
        unknown.push(code);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("ERROR_CODES and documented codes are exactly equal (zero drift)", () => {
    const registeredArray = [...registeredCodes].sort();
    const documentedArray = [...documentedCodes].sort();
    expect(registeredArray).toEqual(documentedArray);
  });
});
