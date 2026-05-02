import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, type ErrorCode } from "../../src/domain/types.js";

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
  // Match table data rows: | `code_name` | ... |
  // Only capture the first backtick-quoted token on each row (the code column).
  const rowPattern = /^\|\s*`([a-z][a-z_]+)`\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowPattern.exec(section)) !== null) {
    if (m[1] !== undefined) codes.add(m[1]);
  }
  return codes;
}

/**
 * Scan src/**\/*.ts files for error code string literals used in code: "..." patterns.
 * Returns the set of all unique code values found.
 */
function scanSourceCodes(): Set<string> {
  const codes = new Set<string>();
  const codePattern = /\bcode:\s*["']([a-z][a-z_]*)["']/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        const text = readFileSync(full, "utf8");
        codePattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = codePattern.exec(text)) !== null) {
          if (m[1] !== undefined) codes.add(m[1]);
        }
      }
    }
  }

  walk(SRC_DIR);
  return codes;
}

describe("Error code contract", () => {
  const contractContents = readFileSync(MACHINE_CONTRACTS_PATH, "utf8");
  const documentedCodes = parseDocumentedCodes(contractContents);
  const registeredCodes = new Set<string>(Object.values(ERROR_CODES) as ErrorCode[]);

  it("ERROR_CODES covers every code documented in machine-contracts.md", () => {
    const missing: string[] = [];
    for (const code of documentedCodes) {
      if (!registeredCodes.has(code)) missing.push(code);
    }
    expect(missing).toEqual([]);
  });

  it("machine-contracts.md documents every code in ERROR_CODES", () => {
    const missing: string[] = [];
    for (const code of registeredCodes) {
      if (!documentedCodes.has(code)) missing.push(code);
    }
    expect(missing).toEqual([]);
  });

  it("every code literal in src matches a value in ERROR_CODES", () => {
    const sourceCodes = scanSourceCodes();
    const unknown: string[] = [];
    for (const code of sourceCodes) {
      if (!registeredCodes.has(code)) unknown.push(code);
    }
    expect(unknown).toEqual([]);
  });

  it("ERROR_CODES and documented codes are exactly equal (zero drift)", () => {
    const registeredArray = [...registeredCodes].sort();
    const documentedArray = [...documentedCodes].sort();
    expect(registeredArray).toEqual(documentedArray);
  });
});
