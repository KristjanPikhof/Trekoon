import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

const QUICKSTART_TEXT = [
  "Trekoon quickstart",
  "",
  "1) Local DB and worktree model",
  "- Every worktree stores tracker state at .trekoon/trekoon.db.",
  "- This DB stays local; it is not merged by Git automatically.",
  "",
  "2) Pre-merge sync flow",
  "- Run: trekoon sync status",
  "- Pull upstream tracker events: trekoon sync pull --from main",
  "- Resolve conflicts if needed: trekoon sync resolve <id> --use ours",
  "- Run sync status again before opening or merging a PR.",
  "",
  "3) Task details and description",
  "- Human view is compact: id | epic | title | status.",
  "- For full task payload (including description), use --toon:",
  "  trekoon task show <task-id> --toon",
  "",
  "4) TOON output examples",
  "- trekoon quickstart --toon",
  "- trekoon task show <task-id> --toon",
  "- trekoon sync status --toon",
].join("\n");

export async function runQuickstart(_: CliContext): Promise<CliResult> {
  return okResult({
    command: "quickstart",
    human: QUICKSTART_TEXT,
    data: {
      localModel: {
        storageDir: ".trekoon",
        databaseFile: ".trekoon/trekoon.db",
        mergeBehavior: "manual-sync",
      },
      preMergeFlow: [
        "trekoon sync status",
        "trekoon sync pull --from main",
        "trekoon sync resolve <id> --use ours",
        "trekoon sync status",
      ],
      toonExamples: [
        "trekoon quickstart --toon",
        "trekoon task show <task-id> --toon",
        "trekoon sync status --toon",
      ],
    },
  });
}
