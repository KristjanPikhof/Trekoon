import type { ExportBundle, ExportExternalNode, ExportStatusCounts, ExportWarning } from "./types";
import type { SubtaskRecord, TaskRecord } from "../domain/types";

export function renderMarkdown(bundle: ExportBundle): string {
  const lines: string[] = [];

  renderFrontmatter(lines, bundle);
  renderTitle(lines, bundle);
  renderSummaryTable(lines, bundle);
  renderDescription(lines, bundle);
  renderTaskIndex(lines, bundle);
  renderTaskDetails(lines, bundle);
  renderDependencies(lines, bundle);
  renderExternalNodes(lines, bundle);
  renderWarnings(lines, bundle);
  renderFooter(lines, bundle);

  return lines.join("\n") + "\n";
}

// --- Markdown escaping helpers ---

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeHeading(text: string): string {
  return text.replace(/\n/g, " ").replace(/#+\s*/g, "");
}

function escapeInlineText(text: string): string {
  return text.replace(/([[\]`*_~])/g, "\\$1").replace(/\n/g, " ");
}

function escapeBlockText(text: string): string {
  // Descriptions are rendered as block content; preserve newlines but
  // ensure lines that start with Markdown structural characters are safe.
  return text
    .split("\n")
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return `\\${line}`;
      if (/^(\s*[-*+]|\s*\d+\.)\s/.test(line)) return line;
      if (/^\s*\|/.test(line)) return `\\${line}`;
      return line;
    })
    .join("\n");
}

function formatDescriptionIndented(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

// --- Render sections ---

function renderFrontmatter(lines: string[], bundle: ExportBundle): void {
  lines.push("---");
  lines.push(`epic_id: ${bundle.epic.id}`);
  lines.push(`schema_version: ${bundle.schemaVersion}`);
  lines.push(`exported_at: ${new Date(bundle.exportedAt).toISOString()}`);
  lines.push(`status: ${bundle.epic.status}`);
  lines.push("---");
  lines.push("");
}

function renderTitle(lines: string[], bundle: ExportBundle): void {
  lines.push(`# ${escapeHeading(bundle.epic.title)}`);
  lines.push("");
}

function renderSummaryTable(lines: string[], bundle: ExportBundle): void {
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Tasks | ${bundle.summary.taskCount} |`);
  lines.push(`| Subtasks | ${bundle.summary.subtaskCount} |`);
  lines.push(`| Dependencies | ${bundle.summary.dependencyCount} |`);
  lines.push(`| External nodes | ${bundle.summary.externalNodeCount} |`);
  lines.push(`| Warnings | ${bundle.summary.warningCount} |`);
  lines.push("");

  if (bundle.summary.taskCount > 0) {
    lines.push("### Task status breakdown");
    lines.push("");
    renderStatusTable(lines, bundle.summary.taskStatuses);
    lines.push("");
  }

  if (bundle.summary.subtaskCount > 0) {
    lines.push("### Subtask status breakdown");
    lines.push("");
    renderStatusTable(lines, bundle.summary.subtaskStatuses);
    lines.push("");
  }
}

function renderStatusTable(lines: string[], counts: ExportStatusCounts): void {
  lines.push("| Status | Count |");
  lines.push("|--------|-------|");
  if (counts.todo > 0) lines.push(`| todo | ${counts.todo} |`);
  if (counts.inProgress > 0) lines.push(`| in_progress | ${counts.inProgress} |`);
  if (counts.done > 0) lines.push(`| done | ${counts.done} |`);
  if (counts.blocked > 0) lines.push(`| blocked | ${counts.blocked} |`);
  if (counts.other > 0) lines.push(`| other | ${counts.other} |`);
}

function renderDescription(lines: string[], bundle: ExportBundle): void {
  if (!bundle.epic.description) return;

  lines.push("## Description");
  lines.push("");
  lines.push(escapeBlockText(bundle.epic.description));
  lines.push("");
}

function renderTaskIndex(lines: string[], bundle: ExportBundle): void {
  if (bundle.tasks.length === 0) return;

  lines.push("## Task index");
  lines.push("");
  lines.push("| # | Title | Status | Subtasks |");
  lines.push("|---|-------|--------|----------|");

  for (let i = 0; i < bundle.tasks.length; i++) {
    const task = bundle.tasks[i];
    const subtaskCount = bundle.subtasks.filter((s) => s.taskId === task.id).length;
    const anchor = taskAnchor(task);
    lines.push(`| ${i + 1} | [${escapeTableCell(escapeInlineText(task.title))}](#${anchor}) | ${task.status} | ${subtaskCount} |`);
  }
  lines.push("");
}

function renderTaskDetails(lines: string[], bundle: ExportBundle): void {
  if (bundle.tasks.length === 0) return;

  lines.push("## Tasks");
  lines.push("");

  for (const task of bundle.tasks) {
    renderSingleTask(lines, task, bundle);
  }
}

function renderSingleTask(lines: string[], task: TaskRecord, bundle: ExportBundle): void {
  lines.push(`### ${escapeHeading(task.title)}`);
  lines.push("");
  lines.push(`**ID:** \`${task.id}\`  `);
  lines.push(`**Status:** ${task.status}  `);
  if (task.owner) {
    lines.push(`**Owner:** ${escapeInlineText(task.owner)}  `);
  }
  lines.push("");

  if (task.description) {
    lines.push(escapeBlockText(task.description));
    lines.push("");
  }

  const blockedBy = bundle.blockedBy.get(task.id) ?? [];
  if (blockedBy.length > 0) {
    lines.push("**Blocked by:**");
    for (const depId of blockedBy) {
      lines.push(`- \`${depId}\``);
    }
    lines.push("");
  }

  const blocks = bundle.blocks.get(task.id) ?? [];
  if (blocks.length > 0) {
    lines.push("**Blocks:**");
    for (const depId of blocks) {
      lines.push(`- \`${depId}\``);
    }
    lines.push("");
  }

  const subtasks = bundle.subtasks.filter((s) => s.taskId === task.id);
  if (subtasks.length > 0) {
    lines.push("#### Subtasks");
    lines.push("");
    for (const subtask of subtasks) {
      renderSingleSubtask(lines, subtask, bundle);
    }
  }
}

function renderSingleSubtask(lines: string[], subtask: SubtaskRecord, bundle: ExportBundle): void {
  const statusIcon = subtask.status === "done" ? "x" : " ";
  lines.push(`- [${statusIcon}] **${escapeInlineText(subtask.title)}** — \`${subtask.id}\` (${subtask.status})`);

  if (subtask.description) {
    lines.push(formatDescriptionIndented(escapeBlockText(subtask.description), "  "));
  }

  const blockedBy = bundle.blockedBy.get(subtask.id) ?? [];
  if (blockedBy.length > 0) {
    lines.push(`  Blocked by: ${blockedBy.map((id) => `\`${id}\``).join(", ")}`);
  }
}

function renderDependencies(lines: string[], bundle: ExportBundle): void {
  if (bundle.dependencies.length === 0) return;

  lines.push("");
  lines.push("## Dependencies");
  lines.push("");
  lines.push("| Source | Depends on | Type |");
  lines.push("|--------|------------|------|");

  for (const dep of bundle.dependencies) {
    const type = dep.internal ? "internal" : "external";
    lines.push(`| \`${dep.sourceId}\` (${dep.sourceKind}) | \`${dep.dependsOnId}\` (${dep.dependsOnKind}) | ${type} |`);
  }
  lines.push("");
}

function renderExternalNodes(lines: string[], bundle: ExportBundle): void {
  if (bundle.externalNodes.length === 0) return;

  lines.push("## External nodes");
  lines.push("");
  lines.push("These nodes belong to other epics but are referenced by dependencies in this epic.");
  lines.push("");
  lines.push("| ID | Kind | Title | Status | Epic ID |");
  lines.push("|----|------|-------|--------|---------|");

  for (const node of bundle.externalNodes) {
    const title = node.title !== null ? escapeTableCell(node.title) : "—";
    lines.push(`| \`${node.id}\` | ${node.kind} | ${title} | ${node.status ?? "—"} | ${node.epicId ?? "—"} |`);
  }
  lines.push("");
}

function renderWarnings(lines: string[], bundle: ExportBundle): void {
  if (bundle.warnings.length === 0) return;

  lines.push("## Warnings");
  lines.push("");
  for (const warning of bundle.warnings) {
    lines.push(`- **${escapeInlineText(warning.code)}**: ${escapeInlineText(warning.message)}`);
  }
  lines.push("");
}

function renderFooter(lines: string[], bundle: ExportBundle): void {
  lines.push("---");
  lines.push("");
  lines.push(`*Exported from Trekoon on ${new Date(bundle.exportedAt).toISOString()}. This is a snapshot — the database is the source of truth.*`);
}

function taskAnchor(task: TaskRecord): string {
  return `task-${task.id}`;
}
