import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The site wears the design draft's own stylesheet, so a component may only use classes that
 * stylesheet defines.
 *
 * This is not tidiness. Inventing `record-dialog` and `record-dialog-backdrop` produced a record
 * detail with no styling at all: an unstyled list of fields dumped under the table, on a page whose
 * entire point is that it looks considered. Nothing failed, nothing warned, and it deployed.
 */
const DESIGN = new URL("../apps/site/src/design/", import.meta.url).pathname;
const COMPONENTS = new URL("../apps/site/src/", import.meta.url).pathname;

// The plate — the clipped control, the content column, the frame — comes from @origin89/brand
// rather than being copied into the design folder, so the package's sheet is part of what the
// design defines. Reading it here also means this test fails if the package stops providing it.
// Resolved from the site, which is where the dependency is declared, not from this file.
const PLATE = createRequire(new URL("../apps/site/package.json", import.meta.url)).resolve(
  "@origin89/brand/tokens/plate.css",
);
const stylesheet = [
  ...readdirSync(DESIGN)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join(DESIGN, file), "utf8")),
  readFileSync(PLATE, "utf8"),
].join("\n");
const defined = new Set([...stylesheet.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
// The draft's own markup counts too. A few of its classes carry no rule of their own because the
// stylesheet reaches them through a parent — `.coverage-grid > div` styles `.coverage-chart` — and
// those are still the design's vocabulary rather than something a component made up.
const draft = readFileSync(
  new URL("../docs/design/data-origin89/index.html", import.meta.url).pathname,
  "utf8",
);
for (const match of draft.matchAll(/class="([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name) defined.add(name);
}

const used = new Map<string, string>();
for (const file of readdirSync(COMPONENTS).filter((f) => f.endsWith(".tsx"))) {
  const source = readFileSync(join(COMPONENTS, file), "utf8");
  for (const match of source.matchAll(/className="([^"{]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.set(name, file);
  }
}

test("every class a component uses is one the design defines", () => {
  const invented = [...used]
    .filter(([name]) => !defined.has(name))
    .map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(invented, [], "these classes have no styling, so they render as nothing");
});

test("the check would notice a class that does not exist", () => {
  // The guard above is only worth having if it can fail, and the failure is silent in a browser.
  assert.equal(defined.has("explorer"), true, "a class the stylesheet really defines");
  assert.equal(defined.has("o89-plate"), true, "a class the brand package defines, not this repo");
  assert.equal(
    defined.has("record-dialog-backdrop"),
    false,
    "the invented one, which must stay unknown",
  );
});
