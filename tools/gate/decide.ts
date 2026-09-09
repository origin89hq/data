import { execFileSync } from "node:child_process";
import { loadRecords, writeRecord, RECORDS_DIR } from "../../src/records.ts";
import { Brand } from "../../schema/brand.ts";
import { Manufacturer } from "../../schema/manufacturer.ts";

/**
 * Answer the gate. One brand per call, because a decision is a person's and a bulk edit is how a
 * model's proposal becomes a fact nobody checked.
 *
 * Usage:
 *   decide.ts list [--all]                          what is waiting, most listings first
 *   decide.ts show <brand-id>                       one entry with its evidence
 *   decide.ts maker <id> <name> [website] [domain…] add a manufacturer
 *   decide.ts is <brand-id> <maker-id> <basis…>     this brand is made by that company, and why
 *   decide.ts skip <brand-id> <reason…>             not equipment this database covers
 */
const [command, ...rest] = process.argv.slice(2);
const records = loadRecords();
const today = new Date().toISOString().slice(0, 10);

/** Who to record. `GATE_REVIEWER` lets an agent working the queue name itself honestly rather than borrow the repository owner's name. */
function reviewer(): string {
  const named = process.env.GATE_REVIEWER?.trim();
  if (named) return named;
  const name = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim();
  if (!name) throw new Error("git config user.name is unset, and a decision needs a name against it");
  return name;
}

function brand(id: string): Brand {
  const found = records.brands.find((b) => b.id === id);
  if (!found) throw new Error(`no brand ${id}; run the queue first or check the id`);
  return found;
}

switch (command) {
  case "list": {
    const all = rest.includes("--all");
    const waiting = records.brands
      .filter((b) => b.decision === "unresolved" && (all || b.evidence.inScope > 0))
      .sort((a, b) => b.evidence.inScope - a.evidence.inScope || b.evidence.listings - a.evidence.listings);
    console.log(`${waiting.length} waiting${all ? "" : " with an in-scope listing"}, of ${records.brands.filter((b) => b.decision === "unresolved").length} unresolved\n`);
    console.log(["brand".padEnd(26), "seen".padStart(5), "scope".padStart(6), " kinds".padEnd(34), "models"].join(" "));
    for (const b of waiting) {
      console.log([b.id.slice(0, 26).padEnd(26), String(b.evidence.listings).padStart(5), String(b.evidence.inScope).padStart(6), ` ${b.evidence.kinds.slice(0, 2).join(", ")}`.slice(0, 34).padEnd(34), b.evidence.models.slice(0, 3).join(", ").slice(0, 52)].join(" "));
    }
    break;
  }
  case "show": {
    const b = brand(rest[0]);
    console.log(JSON.stringify(b, null, 2));
    break;
  }
  case "maker": {
    const [id, name, website, ...domains] = rest;
    if (!id || !name) throw new Error("usage: maker <id> <name> [website] [domain…]");
    const maker = Manufacturer.parse({ id, name, ...(website ? { website } : {}), domains });
    writeRecord(RECORDS_DIR, "manufacturers", maker.id, maker);
    console.log(`manufacturer ${maker.id}: ${maker.name}${maker.domains.length ? ` (${maker.domains.join(", ")})` : " — no domain yet, so hop two cannot crawl it"}`);
    break;
  }
  case "is": {
    const [brandRef, makerId, ...why] = rest;
    const b = brand(brandRef);
    if (!records.manufacturers.some((m) => m.id === makerId)) throw new Error(`no manufacturer ${makerId}; add it with: decide.ts maker ${makerId} "<name>"`);
    const basis = why.join(" ");
    if (!basis) throw new Error("a basis is required: say what settled it, or the next reader cannot check the decision");
    const next = Brand.parse({ ...b, decision: "manufacturer", manufacturer: makerId, reason: undefined, checkedAt: today, reviewedBy: reviewer(), basis });
    writeRecord(RECORDS_DIR, "brands", next.id, next);
    console.log(`${next.brand} → ${makerId}, decided by ${next.reviewedBy} on ${today}`);
    break;
  }
  case "skip": {
    const [brandRef, ...words] = rest;
    const b = brand(brandRef);
    const reason = words.join(" ");
    if (!reason) throw new Error("a reason is required: an unexplained skip is a decision nobody can revisit");
    const next = Brand.parse({ ...b, decision: "out-of-scope", manufacturer: undefined, reason, checkedAt: today, reviewedBy: reviewer(), basis: reason });
    writeRecord(RECORDS_DIR, "brands", next.id, next);
    console.log(`${next.brand} out of scope: ${reason}`);
    break;
  }
  default:
    console.error("usage: decide.ts list|show|maker|is|skip …  (see the file header)");
    process.exit(2);
}
