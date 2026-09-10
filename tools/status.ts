import { loadRecords } from "../src/records.ts";

/**
 * One page that says what this thing knows, what it is waiting on, and what is waiting on you.
 *
 * The failure it answers is the quiet one: a run stops halfway and looks exactly like a shop that
 * shrank, a cron loses a dozen crawls and nothing says so. Everything here is derived — the
 * archive for the pipeline, the records for the review queue — so there is no second copy of the
 * truth to go stale.
 *
 * Usage: status.ts
 * Set OFFGRID_BASE_URL and OFFGRID_CONTROL_TOKEN to inspect a deployment.
 */
const base = (process.env.OFFGRID_BASE_URL ?? "http://localhost:8790").replace(/\/$/, "");
const token = process.env.OFFGRID_CONTROL_TOKEN ?? "";

interface SellerState {
  seller: string;
  date?: string;
  sightings?: number;
  classified?: { parts: number; written: number };
}
interface MakerState {
  maker: string;
  date?: string;
  offered?: number;
  specPages?: number;
  approvedBy?: string;
  fetched?: number;
  converted?: number;
  read?: number;
  seeing?: number;
  seen?: number;
  waitingOn: string;
}

const records = loadRecords();
const specs = records.specs.length;
const withFigures = new Set(records.specs.map((s) => s.model)).size;

console.log("RECORDS");
console.log(
  `  ${records.manufacturers.length} manufacturers · ${records.models.length} models · ${specs} figures over ${withFigures} models`,
);
console.log(`  ${records.dialects.length} dialects · ${records.sources.length} sources`);

const waiting = records.brands.filter((b) => b.decision === "unresolved");
const inScope = waiting.filter((b) => b.evidence.inScope > 0);
const noKind = records.models.filter((m) => !m.kind).length;
const unconfirmed = records.specs.filter((s) => !s.reviewedBy).length;

console.log("\nWAITING ON YOU");
console.log(`  ${inScope.length} brands with an in-scope listing, of ${waiting.length} unresolved`);
for (const b of inScope.slice(0, 5))
  console.log(
    `      ${b.brand} — ${b.evidence.inScope} listings, ${b.evidence.models.slice(0, 2).join(", ")}`,
  );
console.log(`  ${unconfirmed} figures nobody has confirmed`);
console.log(`  ${noKind} models nothing has classified`);

let state: { sellers: SellerState[]; makers: MakerState[] } | undefined;
try {
  const response = await fetch(`${base}/state`, { headers: { authorization: `Bearer ${token}` } });
  if (response.ok) state = (await response.json()) as typeof state;
  else console.log(`\nPIPELINE\n  ${base} answered ${response.status}`);
} catch (error) {
  console.log(
    `\nPIPELINE\n  ${base} is not answering: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (state) {
  const stale = state.sellers.filter(
    (s) => s.classified && s.classified.written < s.classified.parts,
  );
  console.log(`\nSELLERS (${state.sellers.length} crawled)`);
  console.log(
    `  ${state.sellers.reduce((n, s) => n + (s.sightings ?? 0), 0)} sightings in the last crawl of each`,
  );
  if (stale.length) {
    console.log(`  ${stale.length} with a classification that did not finish:`);
    for (const s of stale.slice(0, 5))
      if (s.classified)
        console.log(`      ${s.seller}: ${s.classified.written} of ${s.classified.parts} parts`);
  }

  const byWait = new Map<string, MakerState[]>();
  for (const m of state.makers) byWait.set(m.waitingOn, [...(byWait.get(m.waitingOn) ?? []), m]);
  console.log(`\nMAKERS (${state.makers.length})`);
  for (const [what, makers] of [...byWait.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(makers.length).padStart(3)} waiting on ${what}`);
    if (what.includes("approve") || what.includes("pulled"))
      for (const m of makers.slice(0, 6))
        console.log(
          `      ${m.maker}${m.offered ? ` — ${m.offered} documents offered` : ""}${m.read ? `, ${m.read} read` : ""}`,
        );
  }
  // The page reader's progress. A scan counts as read by the text reader, which found nothing in
  // it, so without this line the second look would be invisible here.
  const seen = state.makers.filter((m) => m.seen);
  const unoffered = state.makers.filter(
    (m) => m.converted !== undefined && m.converted > (m.seeing ?? 0),
  );
  if (seen.length || unoffered.length) {
    console.log(
      `\n  ${seen.reduce((n, m) => n + (m.seen ?? 0), 0)} documents read from their pages, across ${seen.length} makers`,
    );
    if (unoffered.length)
      console.log(
        `  ${unoffered.length} makers with conversions the page reader has not been offered yet`,
      );
  }
  const publishing = state.makers.filter((m) => m.specPages);
  if (publishing.length) {
    console.log(`\n  ${publishing.length} makers publish specification pages of their own:`);
    for (const m of publishing.slice(0, 10)) console.log(`      ${m.maker}: ${m.specPages}`);
  }
}
