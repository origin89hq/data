import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readyToPull } from "../../apps/worker/src/state.ts";
import { makerStates } from "./archive.ts";

/**
 * Pull the figures of every maker whose readings are in: what somebody running `just specs` maker
 * by maker would do, for the scheduled job that puts the result in a pull request.
 *
 * Only a maker whose current run has finished converting is pulled. A run that discovery has just
 * started has nothing in it yet, and pulling it would delete every figure the maker has.
 *
 * One maker at a time on purpose. Each pull ends by removing the sources nothing cites any more,
 * across every maker, and two at once could remove a source the other had just written.
 *
 * Usage: pull-ready-specs.ts [--remote] [--dry-run] [--summary <file>]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const summaryAt = args.indexOf("--summary");
const summaryFile = summaryAt >= 0 ? args[summaryAt + 1] : undefined;
if (summaryAt >= 0 && !summaryFile) {
  console.error("usage: pull-ready-specs.ts [--remote] [--dry-run] [--summary <file>]");
  process.exit(2);
}

const pullSpecs = fileURLToPath(new URL("./pull-specs.ts", import.meta.url));
const states = await makerStates(remote);
// A Worker deployed before `sent` existed reports no maker as ready, and a job that quietly pulled
// nothing every day would look exactly like a pipeline with nothing to read.
if (states.some((m) => m.converted !== undefined) && !states.some((m) => m.sent !== undefined)) {
  console.error("the Worker's /state does not report `sent`, so it predates this; deploy it");
  process.exit(1);
}
const makers = states.filter(readyToPull);
const summary: string[] = [];
for (const maker of makers) {
  const result = spawnSync(
    process.execPath,
    [
      pullSpecs,
      maker.maker,
      maker.date ?? "",
      ...(remote ? ["--remote"] : []),
      ...(dryRun ? ["--dry-run"] : []),
    ],
    { encoding: "utf8" },
  );
  // A pull that never started has no output and no status, only the reason it did not start.
  if (result.error) {
    console.error(`pulling ${maker.maker} did not start: ${result.error.message}`);
    process.exit(1);
  }
  process.stdout.write(`\n## ${maker.maker}\n${result.stdout}`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    // Stopping leaves records half-pulled, which the job's validation refuses: no pull request is
    // built from a run that did not finish, and tomorrow's starts again from main.
    console.error(`pulling ${maker.maker} failed, so nothing after it was pulled`);
    process.exit(result.status ?? 1);
  }
  // Each pull's headline, and anything it took away: removals are what a reviewer most needs to see.
  const [headline = "", ...rest] = result.stdout.split("\n");
  const removed = rest.filter((line) => /removed/.test(line)).map((line) => line.trim());
  summary.push(`- **${maker.maker}** (${maker.date}): ${[headline, ...removed].join("; ")}`);
}
console.log(`\n${makers.length} makers pulled${dryRun ? " (dry run, nothing written)" : ""}`);
if (summaryFile) writeFileSync(summaryFile, `${summary.join("\n")}\n`);
