import { test } from "node:test";
import assert from "node:assert/strict";
import { attachMakers, parseCsv, readFeeds, type FeedModel } from "../src/feeds.ts";

test("a quoted field keeps its commas, and a doubled quote is one quote", () => {
  assert.deepEqual(parseCsv('a,b\n"x,y","he said ""hi"""\n'), [["a", "b"], ["x,y", 'he said "hi"']]);
  assert.deepEqual(parseCsv(""), []);
});

test("the pinned feed reads, and every figure carries the unit its own units row states", () => {
  const [{ feed, models }] = readFeeds();
  assert.equal(feed.license, "BSD-3-Clause");
  assert.ok(models.length > 20_000, "the SAM libraries hold tens of thousands of products");
  const panel = models.find((m) => m.kind === "panel");
  assert.ok(panel?.specs.some((s) => s.name === "Nameplate power at standard test conditions"));
  const inverter = models.find((m) => m.kind === "inverter");
  assert.ok(inverter?.specs.some((s) => s.name === "Maximum AC power output" && s.unit === "W"));
  assert.doesNotMatch(inverter!.name, /^[A-Za-z ]+:/, "an inverter's maker is not left glued to the front of its model name");
});

test("a feed does not mint manufacturers; it attaches only to ones somebody confirmed", () => {
  const rows: FeedModel[] = [
    { id: "a", feed: "f", manufacturerName: "EPEver", name: "X", kind: "panel", specs: [] },
    { id: "b", feed: "f", manufacturerName: "Nobody At All", name: "Y", kind: "panel", specs: [] },
  ];
  const attached = attachMakers(rows, [{ id: "epever", name: "EPEver (Beijing Epsolar Technology)", aliases: ["EP Solar"] }]);
  assert.equal(attached[0].manufacturer, "epever", "a maker's short name reaches its record");
  assert.equal(attached[1].manufacturer, undefined, "an unknown name stays a name, and the gate decides");
  assert.equal(attachMakers(rows, [{ id: "epever", name: "x", aliases: ["EP Solar"] }])[0].manufacturer, undefined);
  assert.equal(attachMakers([{ ...rows[0], manufacturerName: "ep solar" }], [{ id: "epever", name: "x", aliases: ["EP Solar"] }])[0].manufacturer, "epever", "an alias the gate decided reaches it too");
});
