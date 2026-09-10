import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { supervise, VISION_OFFERS_PER_PASS, type SupervisionReport } from "../src/supervise.ts";
import { world } from "./world.ts";

const source = readFileSync(new URL("../src/supervise.ts", import.meta.url), "utf8");

test("the supervisor never approves, because a gate something else can open is not a gate", () => {
  assert.doesNotMatch(source, /sendEvent/, "sending the approval event would make the download automatic");
  assert.doesNotMatch(source, /crawl-approved|APPROVAL_EVENT/, "the supervisor must not know how to approve");
  assert.match(source, /report\.blocked\.push/, "an unapproved maker is reported, not resolved");
});

test("it only fetches specification pages that were adopted into the feed list", () => {
  assert.match(source, /pages\.has\(maker\.maker\)/, "a page nobody adopted is not fetched");
});

test("a classification short of its own manifest is a concern, not something to retry forever", () => {
  assert.match(source, /report\.concerns\.push/);
  assert.match(source, /classified \$\{seller\.classified\.written\} of/);
});

test("the page reader is offered whatever converted since it last looked, a pass's worth of makers at a time", async () => {
  const objects: Record<string, string> = {};
  const convert = (maker: string, sha: string) => {
    const base = `documents/${maker}/runs/2026-09-10-${maker}`;
    const index = objects[`${base}/converting.json`] ? JSON.parse(objects[`${base}/converting.json`]) : { documents: [] };
    index.documents.push({ sha256: sha, url: `https://${maker}.test/${sha.slice(-2)}.pdf` });
    objects[`${base}/converting.json`] = JSON.stringify(index);
    objects[`${base}/converted/${sha}.json`] = "{}";
  };
  const makers = Array.from({ length: VISION_OFFERS_PER_PASS + 5 }, (_, i) => `maker-${String(i + 1).padStart(2, "0")}`);
  for (const [i, maker] of makers.entries()) {
    objects[`documents/${maker}/current.json`] = JSON.stringify({ run: `2026-09-10-${maker}`, date: "2026-09-10", startedAt: "2026-09-10T00:00:00Z" });
    convert(maker, i.toString(16).padStart(64, "0"));
  }
  const { env, sent, store } = world(objects);
  const offered = (report: SupervisionReport) => report.started.filter((s) => s.what === "vision").map((s) => s.entity);

  const first = await supervise(env, "2026-09-10");
  assert.deepEqual(offered(first), makers.slice(0, VISION_OFFERS_PER_PASS));
  assert.deepEqual(first.blocked.map((b) => [b.entity, b.waitingOn]), makers.slice(VISION_OFFERS_PER_PASS).map((m) => [m, "its turn with the page reader"]), "the rest are reported as waiting, not forgotten");
  assert.equal(sent.length, VISION_OFFERS_PER_PASS, "one converted document each");

  assert.deepEqual(offered(await supervise(env, "2026-09-11")), makers.slice(VISION_OFFERS_PER_PASS), "the pass after takes the rest");
  assert.deepEqual(offered(await supervise(env, "2026-09-12")), [], "and once every run has been offered, nothing is offered again");

  // A document that converts later reopens its maker, and only its maker.
  convert("maker-03", "f".repeat(64));
  for (const [key, value] of Object.entries(objects)) store.set(key, new TextEncoder().encode(value));
  assert.deepEqual(offered(await supervise(env, "2026-09-13")), ["maker-03"]);
});
