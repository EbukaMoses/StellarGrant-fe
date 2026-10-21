// "timestamp" is valid for both PostgreSQL and SQLite (better-sqlite3).
// "datetime" is SQLite-only and rejected by PostgreSQL, so we never use it.
export const timestampColumnType = "timestamp";
