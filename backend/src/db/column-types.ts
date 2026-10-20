// The SQL.js test driver uses SQLite's datetime type; PostgreSQL uses timestamp.
export const timestampColumnType =
  process.env.NODE_ENV === "test" ? "datetime" : "timestamp";
