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
  "- Human list view defaults to table format.",
  "- Alternate list view: add --view compact.",
  "- Full tree + descriptions: trekoon epic show <epic-id> --all --json",
  "- For full task payload (including description), use --json:",
  "  trekoon task show <task-id> --all --json",
  "",
  "4) Machine output examples",
  "- trekoon quickstart --json",
  "- trekoon task show <task-id> --all --json",
  "- trekoon epic show <epic-id> --all --json",
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
      machineExamples: [
        "trekoon quickstart --json",
        "trekoon task show <task-id> --all --json",
        "trekoon epic show <epic-id> --all --json",
        "trekoon sync status --toon",
      ],
    },
  });
}
