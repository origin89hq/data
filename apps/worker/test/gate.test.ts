import assert from "node:assert/strict";
import { test } from "node:test";
import { readDocument } from "../src/extract.ts";
import {
  GATE_SYSTEM,
  gateKey,
  gatePrompt,
  keptSections,
  leftUnread,
  pagesToRead,
  SECTIONS_SYSTEM,
  sectionsKey,
  sectionsPrompt,
} from "../src/gate.ts";
import { CONVERTER, EXTRACTOR_ID } from "../src/reading.ts";
import { LAST_ATTEMPT, partKey, readerKey } from "../src/work.ts";
import { type TestAiInput, world } from "./world.ts";

const SHA = "d".repeat(64);
const MARKDOWN = partKey.markdown(SHA, CONVERTER);
const readingKey = partKey.reading(SHA, "maker", readerKey(EXTRACTOR_ID));
const message = {
  kind: "extract" as const,
  run: "2026-09-17-aaaaaaaa",
  manufacturer: "maker",
  date: "2026-09-17",
  sha256: SHA,
  url: "https://maker.test/partner%20note.pdf",
  key: MARKDOWN,
};
const DOCUMENT = "# Title\n\n- Producer=InDesign\n\n### Page 1\nThe S-550 weighs 42 kg.\n";

/** A model that sorts the document as `kind` and reads one figure from each window. */
function model(kind: object | Error | string) {
  return (_call: number, input: TestAiInput): unknown => {
    if (input.messages[0]?.content === GATE_SYSTEM) {
      if (kind instanceof Error) return kind;
      return { response: typeof kind === "string" ? kind : JSON.stringify(kind) };
    }
    return {
      response: JSON.stringify({
        products: [
          {
            model: "S-550",
            is: "product",
            specs: [{ name: "Weight", value: "42", unit: "kg", is: "rating" }],
          },
        ],
      }),
    };
  };
}
const gateCalls = (asked: { input: TestAiInput }[]) =>
  asked.filter((a) => a.input.messages[0]?.content === GATE_SYSTEM).length;

test("a gate's answer is asked for steadily, since it is kept and stands for good", async () => {
  const { env, asked } = world(
    { [MARKDOWN]: DOCUMENT },
    model({ kind: "datasheet", ownRatings: true, reason: "" }),
  );
  await readDocument(message, env, 1);
  const gate = asked.find((a) => a.input.messages[0]?.content === GATE_SYSTEM);
  assert.equal(gate?.input.temperature, 0, "the same document must sort the same way twice");
  assert.deepEqual(gate?.input.chat_template_kwargs, { thinking: false });
});

test("a document of a kind that rates nothing of the maker's is sorted once and left unread", async () => {
  const note = { kind: "compatibility-note", ownRatings: false, reason: "Partner batteries." };
  const { env, asked, readObject, pace } = world({ [MARKDOWN]: DOCUMENT }, model(note));
  await readDocument(message, env, 1);
  assert.equal(asked.length, 1, "the gate's call alone: no window is read");
  assert.equal(pace.asked, 1, "and it took a turn with the model");
  assert.deepEqual(readObject(gateKey(SHA, "maker")), note, "the kind is kept beside the document");
  assert.deepEqual(readObject(readingKey), {
    sha256: SHA,
    url: message.url,
    products: [],
    windows: 0,
    failed: 0,
    skipped: note,
  });
});

test("a document that rates the maker's products is sorted once and read, and a later delivery does not ask again", async () => {
  const sheet = { kind: "datasheet", ownRatings: true, reason: "A spec sheet." };
  const { env, asked, readObject } = world({ [MARKDOWN]: DOCUMENT }, model(sheet));
  await readDocument(message, env, 1);
  assert.equal(gateCalls(asked), 1);
  assert.equal(asked.length, 2, "one window read after it");
  assert.deepEqual(
    (readObject(readingKey) as { products: { model: string }[] }).products.map((p) => p.model),
    ["S-550"],
  );

  const again = world(
    { [MARKDOWN]: DOCUMENT, [gateKey(SHA, "maker")]: `${JSON.stringify(sheet)}\n` },
    model(sheet),
  );
  await readDocument(message, again.env, 1);
  assert.equal(gateCalls(again.asked), 0, "a kind kept is not asked for again");
  assert.equal(again.pace.asked, 1, "and costs no turn: only the window's");
});

test("a document two makers publish is sorted and read for each, and one maker's answer is never the other's (#206)", async () => {
  const kinds: Record<string, object> = {
    maker: { kind: "datasheet", ownRatings: true, reason: "Its own sheet." },
    shop: { kind: "compatibility-note", ownRatings: false, reason: "A supplier's battery." },
  };
  const { env, asked, readObject } = world({ [MARKDOWN]: DOCUMENT }, (call, input) => {
    if (input.messages[0]?.content !== GATE_SYSTEM) return model({})(call, input);
    const maker = /^Maker: (\S+)/.exec(String(input.messages[1]?.content))?.[1] ?? "";
    return { response: JSON.stringify(kinds[maker]) };
  });
  await readDocument({ ...message, manufacturer: "shop" }, env, 1);
  await readDocument(message, env, 1);
  assert.equal(gateCalls(asked), 2, "sorted once for each maker");
  assert.deepEqual(readObject(gateKey(SHA, "shop")), kinds.shop);
  assert.deepEqual(readObject(gateKey(SHA, "maker")), kinds.maker);
  const shop = readObject(partKey.reading(SHA, "shop", readerKey(EXTRACTOR_ID))) as {
    products: unknown[];
    skipped?: object;
  };
  assert.deepEqual([shop.products, shop.skipped], [[], kinds.shop]);
  assert.deepEqual(
    (readObject(readingKey) as { products: { model: string }[] }).products.map((p) => p.model),
    ["S-550"],
    "the maker's own sheet is read, not left unread as the shop's was",
  );
});

test("a selector guide is read when it rates the maker's products and left when it rates another company's equipment", () => {
  assert.equal(leftUnread({ kind: "selector-guide", ownRatings: true, reason: "" }), false);
  assert.equal(leftUnread({ kind: "selector-guide", ownRatings: false, reason: "" }), true);
  for (const kind of [
    "certificate-or-test-report",
    "safety-data-sheet",
    "training-or-presentation",
    "letter-or-regulatory",
    "case-study",
    "settings-template",
  ] as const)
    assert.equal(leftUnread({ kind, ownRatings: true, reason: "" }), true, kind);
  for (const kind of [
    "datasheet",
    "manual",
    "catalog",
    "brochure",
    "installation-guide",
    "other",
  ] as const)
    assert.equal(leftUnread({ kind, ownRatings: false, reason: "" }), false, kind);
});

test("a document the pace turns away before sorting waits its turn, with nothing written", async () => {
  const { env, asked, sent, pace, read } = world(
    { [MARKDOWN]: DOCUMENT },
    model({ kind: "datasheet", ownRatings: true, reason: "" }),
  );
  pace.allow = () => false;
  await readDocument(message, env, 1);
  assert.equal(asked.length, 0);
  assert.deepEqual(sent, [{ ...message, waits: 1 }]);
  assert.equal(read(gateKey(SHA, "maker")), undefined);
  assert.equal(read(readingKey), undefined);
});

test("a gate answer that cannot be read is retried, and on the last delivery the document is read rather than lost", async () => {
  const first = world({ [MARKDOWN]: DOCUMENT }, model("not json"));
  await assert.rejects(readDocument(message, first.env, 1), SyntaxError);
  assert.equal(first.read(readingKey), undefined, "the queue tries it again");

  const last = world(
    { [MARKDOWN]: DOCUMENT },
    model('{"kind":"poster","ownRatings":true,"reason":""}'),
  );
  await readDocument(message, last.env, LAST_ATTEMPT);
  assert.equal(last.read(gateKey(SHA, "maker")), undefined, "a kind outside the list is not kept");
  assert.deepEqual(
    (last.readObject(readingKey) as { products: { model: string }[] }).products.map((p) => p.model),
    ["S-550"],
  );
});

test("the gate is shown the maker, the decoded address and the document from its first page on, up to eight thousand characters", () => {
  const long = `# Title\n- Author=x\n### Page 1\n${"a".repeat(9000)}`;
  const prompt = gatePrompt("Morningstar", "https://maker.test/a%20b.pdf", long);
  assert.match(
    prompt,
    /^Maker: Morningstar\nAddress: https:\/\/maker\.test\/a b\.pdf\n\n### Page 1\n/,
  );
  assert.equal(
    prompt.includes("Author=x"),
    false,
    "the metadata before the first page is left out",
  );
  assert.equal(
    prompt.length,
    "Maker: Morningstar\nAddress: https://maker.test/a b.pdf\n\n".length + 8000,
  );
  assert.match(
    gatePrompt("M", "%E0%A4%A", "no pages"),
    /Address: %E0%A4%A\n\nno pages$/,
    "an address that does not decode is shown as given, and a document with no page markers from its start",
  );
});

// ---- the section gate ----

const OUTLINE = [
  { title: "", from: 1, to: 4 },
  { title: "1 General information", from: 5, to: 12 },
  { title: "2 Installation", from: 13, to: 40 },
  { title: "2.2 Requirements for the PV array", from: 15, to: 16 },
  { title: "5 Others", from: 41, to: 48 },
  { title: "6 Technical Specifications", from: 49, to: 54 },
];

test("the section gate is shown the maker and every section with its pages, numbered from nothing", () => {
  const prompt = sectionsPrompt("EPEVER", OUTLINE);
  assert.match(prompt, /^Maker: EPEVER$/m);
  assert.match(prompt, /^0\. pages 1-4: \(no heading\)$/m);
  assert.match(prompt, /^5\. pages 49-54: 6 Technical Specifications$/m);
  // A section given with its opening words is shown with both, so the gate judges by what it holds.
  assert.match(
    sectionsPrompt("EPEVER", [
      {
        title: "2.2 Requirements for the PV array",
        from: 15,
        to: 16,
        opening: "The below table is for reference only.",
      },
    ]),
    /^0\. pages 15-16: 2\.2 Requirements for the PV array\n {3}opens: The below table is for reference only\.$/m,
  );
  // What the sections are for is said in the prompt, and what to do when neither says.
  assert.match(SECTIONS_SYSTEM, /When neither the name nor the opening says, read it\./);
  assert.match(SECTIONS_SYSTEM, /wrongly left out loses figures/);
});

test("only the kept sections' pages are read, and a document nothing was kept of is read whole", () => {
  assert.deepEqual(
    [...(pagesToRead(OUTLINE, { read: [5] }) ?? [])],
    [49, 50, 51, 52, 53, 54],
    "the specifications, and nothing else",
  );
  assert.deepEqual([...(pagesToRead(OUTLINE, { read: [0, 3] }) ?? [])], [1, 2, 3, 4, 15, 16]);
  // A section the answer names that the outline does not have is not a page range anybody can read.
  assert.deepEqual([...(pagesToRead(OUTLINE, { read: [9] }) ?? [])], []);
  assert.equal(
    pagesToRead(OUTLINE, { read: [] }),
    undefined,
    "keeping none is not reading none: the document is read whole",
  );
  assert.equal(pagesToRead([], { read: [0] }), undefined);
});

test("a document's sections are kept beside it, by maker, and read back", async () => {
  const kept = { read: [0, 5], reason: "the datasheet page and the specifications" };
  const { env, readObject } = world({
    [sectionsKey(SHA, "maker")]: `${JSON.stringify(kept)}\n`,
  });
  assert.deepEqual(await keptSections(env, SHA, "maker"), kept);
  assert.equal(
    await keptSections(env, SHA, "other-maker"),
    undefined,
    "another maker's is not this one's",
  );
  assert.equal(readObject(sectionsKey(SHA, "maker")) !== undefined, true);
  // A file that is not an answer is no answer, rather than an answer nobody checked.
  const broken = world({ [sectionsKey(SHA, "maker")]: '{"read":"all"}\n' });
  assert.equal(await keptSections(broken.env, SHA, "maker"), undefined);
});
