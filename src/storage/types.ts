export interface MutableRow {
  readonly created_at: number;
  readonly updated_at: number;
  readonly version: number;
}

export interface MigrationRecord {
  readonly id: number;
  readonly name: string;
  readonly applied_at: number;
}

export interface TrekoonStorageConfig {
  readonly workingDirectory: string;
}
