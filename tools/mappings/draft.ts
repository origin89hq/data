import { PROPERTIES } from "@origin89/equipment-schema/properties";
import { loadRecords } from "../../src/records.ts";
import { unmappedFigures } from "./unmapped.ts";

/**
 * What a maker prints that no rule reads yet, grouped by the key each name most likely belongs
 * to, with the kinds, units, sample values and documents behind it. A mapping file starts from
 * this list rather than from memory: the author keeps the names that mean what the key means,
 * drops the ones that do not, and writes each basis from the documents named here.
 *
 *   node tools/mappings/draft.ts <manufacturer-id>
 */
const [maker] = process.argv.slice(2);
if (!maker) {
  console.error("usage: node tools/mappings/draft.ts <manufacturer-id>");
  process.exit(2);
}
const records = loadRecords();
if (!records.manufacturers.some((m) => m.id === maker)) {
  console.error(`${maker} is not a manufacturer`);
  process.exit(2);
}
const modelOf = new Map(records.models.map((m) => [m.id, m]));

/** Which key a name most likely belongs to, from its words. A guess to review, never a rule. */
const GUESS: [string, RegExp][] = [
  [
    "pv.voc.max",
    /(open[- ]circuit|\bvoc\b|(pv|solar|array).*(max|maximum).*volt|(max|maximum).*(pv|solar|array).*volt)/i,
  ],
  ["pv.isc.max", /(short[- ]circuit|\bisc\b)/i],
  ["pv.mppt.window", /(mpp|mppt).*(range|window)/i],
  ["pv.power.max", /(pv|solar|array).*(power|watt)|(power|watt).*(pv|solar|array)/i],
  ["inverter.power.surge", /(surge|peak|overload)/i],
  ["inverter.power.idle", /(idle|no[- ]load|zero[- ]load|self[- ]consumption|standby|search)/i],
  ["inverter.power.continuous", /(continuous|rated|nominal|output).*(power|watt|va)/i],
  ["inverter.voltage.ac", /(ac|output).*volt/i],
  ["charge.current.max", /(charg|bulk).*(current|amp)|(current|amp).*charg/i],
  ["battery.capacity", /capacity/i],
  ["battery.energy", /energy|kwh|wh\b/i],
  ["battery.voltage.nominal", /(nominal|rated|system|battery).*volt/i],
];
const guess = (name: string): string => GUESS.find(([, re]) => re.test(name))?.[0] ?? "(no key)";

interface Entry {
  name: string;
  count: number;
  kinds: Map<string, number>;
  units: Map<string, number>;
  values: string[];
  sources: Set<string>;
}
const byKey = new Map<string, Map<string, Entry>>();
const said = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
for (const s of unmappedFigures(records, maker)) {
  const m = modelOf.get(s.model);
  if (!m?.kind) continue;
  const key = guess(s.name);
  const group = byKey.get(key) ?? new Map<string, Entry>();
  const e: Entry = group.get(said(s.name)) ?? {
    name: s.name,
    count: 0,
    kinds: new Map(),
    units: new Map(),
    values: [],
    sources: new Set(),
  };
  e.count += 1;
  e.kinds.set(m.kind, (e.kinds.get(m.kind) ?? 0) + 1);
  e.units.set(s.unit ?? "-", (e.units.get(s.unit ?? "-") ?? 0) + 1);
  if (e.values.length < 3 && !e.values.includes(s.value)) e.values.push(s.value);
  e.sources.add(s.source);
  group.set(said(s.name), e);
  byKey.set(key, group);
}
const order = [...PROPERTIES.map((p) => p.key), "(no key)"];
for (const key of order) {
  const group = byKey.get(key);
  if (!group) continue;
  console.log(`\n== ${key}`);
  for (const e of [...group.values()].sort((a, b) => b.count - a.count)) {
    const kinds = [...e.kinds].map(([k, n]) => `${k}:${n}`).join(",");
    const units = [...e.units].map(([k, n]) => `${k}:${n}`).join(",");
    console.log(
      `${String(e.count).padStart(4)}  ${e.name}\n      kinds ${kinds} · units ${units} · ${e.sources.size} document${e.sources.size === 1 ? "" : "s"} · ${e.values.map((v) => JSON.stringify(v)).join(" ")}`,
    );
  }
}
