import assert from "node:assert/strict";
import { test } from "node:test";
import { readDocument } from "../src/extract.ts";
import { GATE_SYSTEM, gateKey, gatePrompt, leftUnread } from "../src/gate.ts";
import { CONVERTER, EXTRACTOR_ID } from "../src/reading.ts";
import { LAST_ATTEMPT, partKey, readerKey } from "../src/work.ts";
import { type TestAiInput, world } from "./world.ts";

const SHA = "d".repeat(64);
const MARKDOWN = partKey.markdown(SHA, CONVERTER);
const readingKey = partKey.reading(SHA, readerKey(EXTRACTOR_ID));
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

test("a document of a kind that rates nothing of the maker's is sorted once and left unread", async () => {
  const note = { kind: "compatibility-note", ownRatings: false, reason: "Partner batteries." };
  const { env, asked, readObject, pace } = world({ [MARKDOWN]: DOCUMENT }, model(note));
  await readDocument(message, env, 1);
  assert.equal(asked.length, 1, "the gate's call alone: no window is read");
  assert.equal(pace.asked, 1, "and it took a turn with the model");
  assert.deepEqual(readObject(gateKey(SHA)), note, "the kind is kept beside the document");
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
    { [MARKDOWN]: DOCUMENT, [gateKey(SHA)]: `${JSON.stringify(sheet)}\n` },
    model(sheet),
  );
  await readDocument(message, again.env, 1);
  assert.equal(gateCalls(again.asked), 0, "a kind kept is not asked for again");
  assert.equal(again.pace.asked, 1, "and costs no turn: only the window's");
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
  assert.equal(read(gateKey(SHA)), undefined);
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
  assert.equal(last.read(gateKey(SHA)), undefined, "a kind outside the list is not kept");
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
