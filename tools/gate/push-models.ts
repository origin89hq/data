import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecords } from "../../src/records.ts";

/**
 * Put the models that still have no kind where the classifier can reach them. Records live in
 * git and a Worker cannot read git, so the queue crosses over as JSONL in the archive.
 *
 * Usage: push-models.ts [--remote] [--all]
 */
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const all = args.includes("--all");
const BUCKET = "offgrid-equipment-archive";
const SCRAPER = new URL("../../scraper/", import.meta.url).pathname;
const PAGE = 500;

const records = loadRecords();
const pending = records.models.filter((m) => all || !m.kind);
if (pending.length === 0) {
  console.log("every model already has a kind");
  process.exit(0);
}
const makers = new Map(records.manufacturers.map((m) => [m.id, m.name]));
const dir = mkdtempSync(join(tmpdir(), "offgrid-push-"));
try {
  const pages: { page: number; count: number }[] = [];
  for (let i = 0; i * PAGE < pending.length; i += 1) {
    const slice = pending.slice(i * PAGE, (i + 1) * PAGE);
    // The classifier reads the sighting shape, so a model is handed over wearing it: the maker's
    // name is the brand and the model name is both title and model, which is all it needs.
    const lines = slice.map((m) =>
      JSON.stringify({
        seller: "models", productId: m.id, handle: m.id, url: `https://example.invalid/${m.id}`,
        title: `${makers.get(m.manufacturer) ?? m.manufacturer} ${m.name}`, brand: makers.get(m.manufacturer) ?? m.manufacturer,
        model: m.name, currency: "CAD", checkedAt: new Date().toISOString().slice(0, 10), extractor: "shopify-feed",
      }),
    );
    const file = join(dir, `page-${String(i + 1).padStart(4, "0")}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    put(`sightings/models/runs/pending/page-${String(i + 1).padStart(4, "0")}.jsonl`, file);
    pages.push({ page: i + 1, count: slice.length });
  }
  const pointerFile = join(dir, "current.json");
  writeFileSync(pointerFile, JSON.stringify({ run: "pending", date: new Date().toISOString().slice(0, 10), startedAt: new Date().toISOString() }));
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ seller: "models", checkedAt: "pending", pages, sightings: pending.length }, null, 2));
  put("sightings/models/runs/pending/manifest.json", manifest);
  put("sightings/models/current.json", pointerFile);
  console.log(`${pending.length} models without a kind → ${pages.length} pages in the archive`);
  console.log(`classify with: curl -X POST 'localhost:8790/classify?seller=models&date=pending'`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function put(key: string, file: string): void {
  execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, remote ? "--remote" : "--local"], {
    cwd: SCRAPER,
    stdio: ["ignore", "ignore", "pipe"],
  });
}
