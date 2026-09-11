import assert from "node:assert/strict";
import { test } from "node:test";
import { type MakerState, type Pipeline, parseState, type RunStatus } from "../src/ops/api.ts";
import { needsApproval, runRows } from "../src/ops/workspace.ts";

const status = (maker: string, value: string): RunStatus => ({
  kind: "maker",
  entity: maker,
  run: "2026-09-11-abcd1234",
  date: "2026-09-11",
  instance: `maker-${maker}-2026-09-11-abcd1234`,
  status: value,
  error: null,
});

const row = (maker: MakerState, run?: string) => {
  const data: Pipeline = {
    sellers: [],
    makers: [maker],
    runs: new Map(run ? [[`maker:${maker.maker}`, status(maker.maker, run)]] : []),
    at: new Date(),
  };
  const [only] = runRows(data);
  assert.ok(only);
  return only;
};

const undecided: MakerState = {
  maker: "renogy",
  date: "2026-09-11",
  offered: 12,
  waitingOn: "somebody to approve the download",
};

test("an undecided plan is in the review queue while its workflow can still take the answer", () => {
  assert.equal(row(undecided, "waiting").category, "review");
  assert.equal(row(undecided, "waiting").next, "somebody to approve the download");
  assert.equal(
    row(undecided).category,
    "review",
    "without workflow statuses, the Worker's word is what there is",
  );
  assert.equal(needsApproval(undecided, status("renogy", "running")), true);
});

test("a decided download leaves the review queue and says how it was decided (#71)", () => {
  const refused = row(
    {
      ...undecided,
      maker: "spypoint",
      decision: "refused",
      waitingOn: "download refused by ada: trail cameras",
    },
    "complete",
  );
  assert.equal(refused.category, "all");
  assert.equal(refused.next, "download refused by ada: trail cameras");

  const downloading = row(
    {
      ...undecided,
      decision: "approved",
      approvedBy: "ada",
      waitingOn: "the download of 12 documents approved by ada",
    },
    "running",
  );
  assert.equal(downloading.category, "active", "an approved run downloading is in progress");
  assert.equal(needsApproval(downloading.maker ?? undecided, downloading.run), false);

  const lapsed = row({ ...undecided, decision: "lapsed", waitingOn: "download not approved" });
  assert.equal(lapsed.category, "all", "a lapsed plan is decided with or without a status");
});

test("a plan whose workflow ended with no recorded decision is not offered for approval", () => {
  // How the runs refused before the Worker recorded decisions read: no manifest, no decision.
  const ended = row(undecided, "complete");
  assert.equal(ended.category, "all");
  assert.match(ended.next, /can no longer take an approval/);
  assert.equal(needsApproval(undecided, status("renogy", "complete")), false);

  const errored = row(undecided, "errored");
  assert.equal(errored.category, "attention", "a stopped workflow still needs somebody to look");
  assert.equal(needsApproval(undecided, status("renogy", "unknown")), false);
});

test("the workspace reads a decision and refuses one it does not know", () => {
  const maker = (decision: unknown) => ({
    sellers: [],
    makers: [{ maker: "renogy", waitingOn: "download refused by ada", offered: 2, decision }],
  });
  assert.equal(parseState(maker("refused")).makers[0]?.decision, "refused");
  assert.equal(parseState(maker(undefined)).makers[0]?.decision, undefined);
  assert.throws(() => parseState(maker("maybe")), /unknown download decision/);
});
