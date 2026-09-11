import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pipeline, RunStatus } from "../apps/site/src/ops/api.ts";
import {
  count,
  csv,
  readView,
  runRows,
  selectRows,
  viewSearch,
} from "../apps/site/src/ops/workspace.ts";

const run: RunStatus = {
  kind: "maker",
  entity: "alpha",
  run: "a1",
  date: "2026-09-11",
  instance: "workflow-a1",
  status: "waiting",
  error: null,
};
const data: Pipeline = {
  at: new Date(),
  makers: [
    { maker: "alpha", offered: 3, waitingOn: "somebody to approve the download" },
    { maker: "beta", fetched: 0, waitingOn: "nothing" },
    { maker: "gamma", read: 4, waitingOn: "nothing" },
  ],
  sellers: [{ seller: "shop", sightings: 0 }],
  runs: new Map([
    ["maker:alpha", run],
    ["maker:beta", { ...run, entity: "beta", status: "errored" }],
    ["seller:shop", { ...run, kind: "seller", entity: "shop", status: "running" }],
  ]),
};
test("the queue prioritizes failures, approvals, running work and available readings", () => {
  const rows = runRows(data);
  assert.deepEqual(
    selectRows(rows, "overview", "all", "", "attention").map((row) => row.entity),
    ["beta", "alpha", "shop", "gamma"],
  );
  assert.deepEqual(
    selectRows(rows, "makers", "review", "", "name").map((row) => row.entity),
    ["alpha"],
  );
  assert.deepEqual(
    selectRows(rows, "sellers", "active", "", "name").map((row) => row.entity),
    ["shop"],
  );
  assert.equal(selectRows(rows, "overview", "all", " WORKFLOW-A1 ", "name").length, 3);
});
test("unknown figures remain missing and empty filters are real empty results", () => {
  assert.equal(count(undefined), "—");
  assert.equal(count(0), "0");
  assert.equal(selectRows(runRows(data), "overview", "all", "no such run", "name").length, 0);
  assert.equal(runRows(data)[1]?.maker?.offered, undefined);
});
test("view URLs round-trip reserved characters and discard unknown options", () => {
  assert.deepEqual(readView(viewSearch("makers", "review", "ac & dc")), {
    view: "makers",
    filter: "review",
    query: "ac & dc",
  });
  assert.deepEqual(readView("?view=admin&filter=delete"), {
    view: "overview",
    filter: "all",
    query: "",
  });
});
test("CSV exports preserve missing values, zero, quotes and newlines without spreadsheet formulas", () => {
  const rows = runRows(data);
  const row = rows[1];
  assert.ok(row);
  const text = csv([{ ...row, entity: '=HYPERLINK("x")', next: 'line one\nline "two"' }]);
  assert.ok(text.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(text.includes('"line one\nline ""two"""'));
  assert.ok(text.includes(',"","0",'));
  assert.ok(text.endsWith("\r\n"));
});

test("waiting and paused work stays in progress while download approvals keep their own queue", () => {
  for (const status of ["waiting", "paused", "waitingForPause"]) {
    const runs = new Map(data.runs);
    runs.set("seller:shop", { ...run, kind: "seller", entity: "shop", status });
    runs.set("maker:gamma", { ...run, entity: "gamma", status });
    const rows = runRows({ ...data, runs });
    assert.deepEqual(
      selectRows(rows, "overview", "active", "", "name").map((row) => row.entity),
      ["gamma", "shop"],
    );
    assert.deepEqual(
      selectRows(rows, "overview", "review", "", "name").map((row) => row.entity),
      ["alpha"],
    );
  }
});
