export const SCHEMA_VERSION = 1;

export const BASE_SCHEMA_STATEMENTS: readonly string[] = [
  `PRAGMA foreign_keys = ON;`,
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS epics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    epic_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (epic_id) REFERENCES epics (id) ON DELETE CASCADE
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS dependencies (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    depends_on_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    git_branch TEXT,
    git_head TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS git_context (
    id TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL,
    branch_name TEXT,
    head_sha TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sync_cursors (
    id TEXT PRIMARY KEY,
    source_branch TEXT NOT NULL,
    cursor_token TEXT NOT NULL,
    last_event_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sync_conflicts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    ours_value TEXT,
    theirs_value TEXT,
    resolution TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);`,
  `CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);`,
  `CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_kind, entity_id);`,
  `CREATE INDEX IF NOT EXISTS idx_conflicts_resolution ON sync_conflicts(resolution);`,
];
