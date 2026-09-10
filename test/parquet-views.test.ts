import assert from "node:assert/strict";
import { test } from "node:test";
import { parquetViews } from "../apps/site/src/useDuckDb.ts";

const file = (url: string) => ({ rows: 1, bytes: 1, sha256: "test", url });
test("opens only Parquet entries with their published URLs", () => {
  assert.deepEqual(
    parquetViews({
      "models.parquet": file("https://data.example/models.parquet"),
      "models.csv": file("https://data.example/models.csv"),
    }),
    [
      {
        name: "models",
        url: "https://data.example/models.parquet",
        sql: "CREATE VIEW \"models\" AS SELECT * FROM read_parquet('https://data.example/models.parquet')",
      },
    ],
  );
});
test("an empty index creates no views", () => {
  assert.deepEqual(parquetViews({}), []);
});
test("quotes table identifiers and URLs without interpolating executable SQL", () => {
  assert.deepEqual(
    parquetViews({ 'quoted"table.parquet': file("https://data.example/it's.parquet") }),
    [
      {
        name: 'quoted"table',
        url: "https://data.example/it's.parquet",
        sql: "CREATE VIEW \"quoted\"\"table\" AS SELECT * FROM read_parquet('https://data.example/it''s.parquet')",
      },
    ],
  );
});
test("rejects a Parquet file without a table name", () => {
  assert.throws(
    () => parquetViews({ ".parquet": file("https://data.example/empty") }),
    /no table name/,
  );
});
