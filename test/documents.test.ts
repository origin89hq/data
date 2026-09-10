import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredLanguage, withoutTranslations } from "../scraper/src/documents.ts";
import { loadRecords } from "../src/records.ts";
import { withoutTranslatedReadings } from "../src/language.ts";

test("a file name that marks a translation declares its language", () => {
  assert.equal(declaredLanguage("https://sol-ark.com/x/8K-2P-N_UserManual_v1.0_ES_05042025-1-1.pdf"), "es");
  assert.equal(declaredLanguage("https://lorentz.de/x/lorentz_ps_hr_general_fr.pdf"), "fr");
  assert.equal(declaredLanguage("https://x.com/SK140-0002-003-15K-2P-N-ES-Manual-1.pdf"), "es");
});

test("an English or unmarked document declares nothing, and a bilingual one is not a translation", () => {
  assert.equal(declaredLanguage("https://x.com/SK140-0005-002-8K-2P-N-EN-Manual-1-1.pdf"), undefined);
  assert.equal(declaredLanguage("https://x.com/MPPT-75-10-datasheet.pdf"), undefined);
  // Both languages in one file: reading it is the only way to get the English.
  assert.equal(declaredLanguage("https://no.co/GB10_Userguide_EN_ES_10.20.2022.pdf"), undefined);
});

test("a language code inside a word is not a language", () => {
  assert.equal(declaredLanguage("https://x.com/GENESIS.pdf"), undefined);
  assert.equal(declaredLanguage("https://x.com/Fronius-Primo.pdf"), undefined);
  assert.equal(declaredLanguage("https://x.com/inverter-espanol-guide.pdf"), undefined);
});

test("a translation is dropped only when the maker publishes something else", () => {
  const both = withoutTranslations([{ url: "https://x.com/manual-ES.pdf" }, { url: "https://x.com/manual-EN.pdf" }]);
  assert.deepEqual(both.keep.map((d) => d.url), ["https://x.com/manual-EN.pdf"]);
  assert.equal(both.dropped[0]?.language, "es");
  // A maker who publishes in French only keeps its French, since the choice is not between
  // one language and two but between a language and nothing.
  const frenchOnly = [{ url: "https://x.com/guide_fr.pdf" }, { url: "https://x.com/fiche-FR.pdf" }];
  assert.deepEqual(withoutTranslations(frenchOnly).keep, frenchOnly);
  assert.deepEqual(withoutTranslations(frenchOnly).dropped, []);
});

test("no document already cited is dropped by a rule that cannot tell a language from a product name", () => {
  // Every source in the repo, so a maker whose part number happens to spell a language code fails here.
  const surprising = loadRecords()
    .sources.filter((s) => s.url && declaredLanguage(s.url))
    .map((s) => `${declaredLanguage(s.url!)}: ${s.url}`);
  assert.ok(surprising.length <= 15, `more documents read as translations than the 15 seen: ${surprising.slice(0, 5).join(", ")}`);
});

test("a maker's translated manual is spotted from what it said, not from what it is called", () => {
  // Pentair marks a Spanish manual "_SPA_" in one place and "-s-" in another, so the file name is
  // no guide. These share a shape with the real ones: a run of names, most of them accented.
  const spanish = { url: "https://x.com/44514-s-manual.pdf", names: ["Corriente máxima", "Tensión de entrada", "Presión mínima", "Voltaje"] };
  const english = { url: "https://x.com/44514-manual.pdf", names: ["Maximum current", "Input voltage", "Minimum pressure", "Voltage"] };
  const { keep, dropped } = withoutTranslatedReadings([spanish, english], (r) => r.names);
  assert.deepEqual(keep.map((r) => r.url), [english.url]);
  assert.deepEqual(dropped.map((r) => r.url), [spanish.url]);
});

test("a maker who publishes in one language only keeps every document it has", () => {
  const only = [
    { url: "https://x.com/a.pdf", names: ["Corriente máxima", "Tensión de entrada", "Presión mínima", "Tipo de batería"] },
    { url: "https://x.com/b.pdf", names: ["Capacidad de la batería", "Potencia máxima", "Rango de temperatura", "Presión de servicio"] },
  ];
  assert.deepEqual(withoutTranslatedReadings(only, (r) => r.names).dropped, []);
});

test("a document too short to judge never decides what language its maker publishes in", () => {
  const thin = { url: "https://x.com/thin.pdf", names: ["Capacité"] };
  const english = { url: "https://x.com/full.pdf", names: ["Maximum current", "Input voltage", "Minimum pressure", "Voltage"] };
  const { keep } = withoutTranslatedReadings([thin, english], (r) => r.names);
  assert.equal(keep.length, 2, "one accented name in a one-line document is not a translated edition");
});
