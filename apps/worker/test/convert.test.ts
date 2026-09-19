import assert from "node:assert/strict";
import { test } from "node:test";
import { convertDocument, pagesUnconverted } from "../src/convert.ts";
import { CONVERTER } from "../src/reading.ts";
import { partKey } from "../src/work.ts";
import { GREY_SCAN, type Placed, pdfium, tinyPdf, writtenPdf } from "./pdf.ts";
import { world } from "./world.ts";

const SHA = "d".repeat(64);
const SOURCE = `archive/${SHA}`;
const MARKDOWN = partKey.markdown(SHA, CONVERTER);
const OUTLINE = partKey.outline(SHA, CONVERTER);
const CONVERTED = partKey.converted("maker", "2026-09-11-aaaaaaaa", SHA);
const message = {
  kind: "convert" as const,
  manufacturer: "maker",
  date: "2026-09-11",
  run: "2026-09-11-aaaaaaaa",
  sha256: SHA,
  url: "https://maker.test/manual.pdf",
  contentType: "application/pdf",
};

/** A manual of `count` pages, its specifications on the last. */
function manual(count: number): Uint8Array {
  const pages: Placed[][] = Array.from({ length: count }, (_, i) => [
    { text: `Installation, page ${i + 1}`, x: 20, y: 180 },
  ]);
  pages[count - 1] = [
    { text: "9.1 Specifications", x: 20, y: 180 },
    { text: "Continuous power 3000 W", x: 20, y: 150 },
  ];
  return writtenPdf(pages);
}

/** The world with a `toMarkdown` that counts its calls and gives `answer`. */
function withToMarkdown(objects: Record<string, string | Uint8Array>, answer = "# A scan\n") {
  const made = world(objects);
  const calls: string[] = [];
  (made.env.AI as unknown as { toMarkdown: unknown }).toMarkdown = async ({
    name,
  }: {
    name: string;
  }) => {
    calls.push(name);
    return { name, format: "markdown", data: answer };
  };
  return { ...made, calls };
}

test("a PDF is written down to its last page, says how many it wrote, and is sent to be read", async () => {
  const { env, calls, sent, text, read } = withToMarkdown({ [SOURCE]: manual(85) });
  await convertDocument(message, env, pdfium);
  const markdown = text(MARKDOWN) ?? "";
  assert.match(markdown, /### Page 85\n[\s\S]*Continuous power 3000 W/);
  assert.deepEqual((await env.ARCHIVE.head(MARKDOWN))?.customMetadata, {
    pages: "85",
    converted: "85",
  });
  assert.ok(
    (read(OUTLINE) as { title: string }[]).some((s) => s.title === "9.1 Specifications"),
    "its outline reaches the last page",
  );
  assert.equal(
    (read(CONVERTED) as { characters: number }).characters,
    new TextEncoder().encode(markdown).length,
  );
  assert.deepEqual(
    sent.map((m) => [m.kind, "key" in m ? m.key : undefined]),
    [["extract", MARKDOWN]],
  );
  assert.equal(calls.length, 0, "a PDF with text is not sent to toMarkdown");
});

test("a PDF converted before it said how many pages it wrote is converted again, once", async () => {
  // Wave 2's documents were converted by a converter that stopped at page 80 and said nothing.
  const cut = "### Page 1\nInstallation, page 1\n";
  const { env, calls, sent, text, read } = withToMarkdown({ [SOURCE]: manual(3), [MARKDOWN]: cut });
  await convertDocument(message, env, pdfium);
  const whole = text(MARKDOWN) ?? "";
  assert.match(whole, /### Page 3\n[\s\S]*Continuous power 3000 W/);
  assert.equal((await env.ARCHIVE.head(MARKDOWN))?.customMetadata?.pages, "3");
  assert.equal(
    (read(CONVERTED) as { characters: number }).characters,
    new TextEncoder().encode(whole).length,
    "the record gives the size of the conversion now kept, not the one it replaced",
  );

  // Now it says, and it is left alone: the document is not so much as opened again.
  await env.ARCHIVE.delete(SOURCE);
  await convertDocument(message, env, pdfium);
  assert.equal(text(MARKDOWN), whole);
  assert.equal(sent.length, 2, "and each time it is sent to be read, which reads only what is new");
  assert.equal(calls.length, 0);
});

test("a conversion that says how many pages it wrote is kept as it is", async () => {
  const { env, sent, text } = withToMarkdown({});
  await env.ARCHIVE.put(MARKDOWN, "### Page 1\nKept\n", {
    customMetadata: { pages: "1", converted: "1" },
  });
  await convertDocument(message, env, pdfium);
  assert.equal(text(MARKDOWN), "### Page 1\nKept\n");
  assert.equal(sent.length, 1);
});

test("a scan converted before is not sent to toMarkdown again", async () => {
  // What toMarkdown wrote stands, and the page reader reads the pages; asking again asks the same.
  const { env, calls, sent, text } = withToMarkdown({
    [SOURCE]: tinyPdf([GREY_SCAN]),
    [MARKDOWN]: "# manual.pdf\n## Contents\n### Page 1\n",
  });
  await convertDocument(message, env, pdfium);
  assert.equal(calls.length, 0);
  assert.equal(text(MARKDOWN), "# manual.pdf\n## Contents\n### Page 1\n");
  assert.equal(sent.length, 1);
});

test("a scan converted for the first time goes to toMarkdown, as it did", async () => {
  const { env, calls, text } = withToMarkdown({ [SOURCE]: tinyPdf([GREY_SCAN]) }, "# A scan\n");
  await convertDocument(message, env, pdfium);
  assert.deepEqual(calls, ["manual.pdf"]);
  assert.equal(text(MARKDOWN), "# A scan\n");
  assert.deepEqual((await env.ARCHIVE.head(MARKDOWN))?.customMetadata, {});
});

test("a document that is not a PDF, converted before, is kept as it is", async () => {
  const { env, calls, text } = withToMarkdown({ [MARKDOWN]: "# A page\n" });
  await convertDocument({ ...message, contentType: "text/html" }, env, pdfium);
  assert.equal(text(MARKDOWN), "# A page\n");
  assert.equal(calls.length, 0);
});

test("pages a conversion did not write down are read off what it says of itself", () => {
  assert.equal(pagesUnconverted({ pages: "2500", converted: "2000" }), 500);
  assert.equal(pagesUnconverted({ pages: "85", converted: "85" }), 0);
  assert.equal(pagesUnconverted({}), 0, "a conversion that says nothing");
  assert.equal(pagesUnconverted(undefined), 0);
  assert.equal(pagesUnconverted({ pages: "many", converted: "2" }), 0);
});
