export interface HumanTableOptions {
  readonly wrapColumns?: readonly number[];
  readonly maxWidth?: number;
}

const DEFAULT_TERMINAL_WIDTH = 100;
const CELL_SEPARATOR = " | ";
const DIVIDER_SEPARATOR = "-+-";

function getTerminalWidth(override?: number): number {
  if (override && override > 0) {
    return override;
  }

  const detected: number | undefined = process.stdout.columns;
  if (!detected || detected <= 0) {
    return DEFAULT_TERMINAL_WIDTH;
  }

  return detected;
}

function splitLongToken(token: string, width: number): string[] {
  if (token.length <= width) {
    return [token];
  }

  const chunks: string[] = [];
  for (let index = 0; index < token.length; index += width) {
    chunks.push(token.slice(index, index + width));
  }

  return chunks;
}

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }

  const tokens = line.split(/\s+/g).filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return [""];
  }

  const wrapped: string[] = [];
  let current = "";

  for (const token of tokens) {
    const tokenParts = splitLongToken(token, width);
    for (const part of tokenParts) {
      if (current.length === 0) {
        current = part;
        continue;
      }

      const combined = `${current} ${part}`;
      if (combined.length <= width) {
        current = combined;
        continue;
      }

      wrapped.push(current);
      current = part;
    }
  }

  if (current.length > 0) {
    wrapped.push(current);
  }

  return wrapped;
}

function wrapCell(value: string, width: number): string[] {
  const normalized = value.replace(/\t/g, " ");
  const paragraphs = normalized.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    lines.push(...wrapLine(paragraph, width));
  }

  return lines.length > 0 ? lines : [""];
}

function shrinkWidths(
  widths: number[],
  wrapColumns: ReadonlySet<number>,
  minimumWidths: readonly number[],
  maxWidth: number,
  separatorWidth: number,
): void {
  const totalWidth = (): number => widths.reduce((sum, width) => sum + width, 0) + separatorWidth;
  const hardMinimumWidth = 4;

  while (totalWidth() > maxWidth) {
    let changed = false;

    for (let index = 0; index < widths.length; index += 1) {
      if (!wrapColumns.has(index)) {
        continue;
      }

      const minWidth = minimumWidths[index] ?? 4;
      const currentWidth = widths[index];
      if (currentWidth !== undefined && currentWidth > minWidth) {
        widths[index] = currentWidth - 1;
        changed = true;
        if (totalWidth() <= maxWidth) {
          return;
        }
      }
    }

    if (changed) {
      continue;
    }

    for (let index = 0; index < widths.length; index += 1) {
      if (!wrapColumns.has(index)) {
        continue;
      }

      const currentWidth = widths[index];
      if (currentWidth !== undefined && currentWidth > hardMinimumWidth) {
        widths[index] = currentWidth - 1;
        changed = true;
        if (totalWidth() <= maxWidth) {
          return;
        }
      }
    }

    if (!changed) {
      return;
    }
  }
}

export function formatHumanTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: HumanTableOptions = {},
): string {
  if (headers.length === 0) {
    return "";
  }

  const wrapColumns = new Set(options.wrapColumns ?? []);
  const minimumWidths = headers.map((header, index) => {
    if (wrapColumns.has(index)) {
      return Math.min(Math.max(header.length, 12), 20);
    }

    return header.length;
  });

  const widths: number[] = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 0);
    return Math.max(header.length, rowMax);
  });

  const separatorWidth = (headers.length - 1) * CELL_SEPARATOR.length;
  shrinkWidths(widths, wrapColumns, minimumWidths, getTerminalWidth(options.maxWidth), separatorWidth);

  const formatSingleLine = (row: readonly string[]): string =>
    row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join(CELL_SEPARATOR);

  const headerLine = formatSingleLine(headers);
  const dividerLine = widths.map((width) => "-".repeat(width)).join(DIVIDER_SEPARATOR);

  const renderedRows: string[] = [];
  for (const row of rows) {
    const wrappedCells = row.map((cell, index) => {
      if (!wrapColumns.has(index)) {
        return [cell ?? ""];
      }

      return wrapCell(cell ?? "", widths[index] ?? 1);
    });
    const height = wrappedCells.reduce((max, cellLines) => Math.max(max, cellLines.length), 1);

    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const lineCells = wrappedCells.map((cellLines, index) => (cellLines[lineIndex] ?? "").padEnd(widths[index] ?? 0));
      renderedRows.push(lineCells.join(CELL_SEPARATOR));
    }
  }

  return [headerLine, dividerLine, ...renderedRows].join("\n");
}
