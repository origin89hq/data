import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverPages,
  type Fetched,
  fetchPage,
  type HostSeen,
  hostsToTry,
  isDocumentAnswer,
  isPage,
  MAX_CHILD_SITEMAPS,
  readPages,
} from "../src/discover.ts";

const urlset = (...urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;
const home = "<!doctype html><html><body>home</body></html>";

type Answer = string | Partial<Fetched>;

/** A site answering from a table of urls, 404 to everything else, and remembering what was asked. */
function site(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const get = async (url: string): Promise<Fetched> => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) return { status: 404, url, text: "" };
    if (typeof answer === "string") return { status: 200, url, text: answer };
    return { status: 200, url, text: "", ...answer };
  };
  return { get, asked };
}

/** A host report with nothing unusual, for the fields a test does not care about. */
const seenAt = (over: Partial<HostSeen>): HostSeen => ({
  domain: "maker.test",
  host: "maker.test",
  status: 200,
  sitemap: "urlset",
  listed: 0,
  own: 0,
  requests: 1,
  refused: 0,
  silent: 0,
  childrenFailed: 0,
  childrenSkipped: 0,
  redirectedTo: [],
  rootRedirectedTo: [],
  listedElsewhere: [],
  ...over,
});

test("a sitemap's own pages are the pages, and nothing else is knocked on", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": urlset(
      "https://maker.test/product/a",
      "https://maker.test/product/b",
      "https://reseller.test/maker-a",
    ),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a", "https://maker.test/product/b"]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml"]);
  assert.deepEqual(hosts, [seenAt({ listed: 3, own: 2, listedElsewhere: ["reseller.test"] })]);
});

test("when the bare host does not answer, the www host is asked, and its home page is the fallback", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": { status: 0 },
    "https://www.maker.test/sitemap.xml": urlset("https://www.maker.test/product/a"),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://www.maker.test/product/a"]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml", "https://www.maker.test/sitemap.xml"]);
  assert.deepEqual(hosts, [
    seenAt({ host: "www.maker.test", listed: 1, own: 1, requests: 2, silent: 1 }),
  ]);
  // A www host whose sitemap is an HTML page falls back to that host's home, not the bare one.
  const html = site({ "https://www.maker.test/sitemap.xml": home });
  assert.deepEqual((await discoverPages(["maker.test"], html.get)).pages, [
    "https://www.maker.test/",
  ]);
});

test("a sitemap that answers with no page on the maker's hosts falls back to the home page", async () => {
  // The HTML home page served at /sitemap.xml, as progressivedyn.com and southwire.com do.
  const page = site({ "https://maker.test/sitemap.xml": home });
  const served = await discoverPages(["maker.test"], page.get);
  assert.deepEqual(served.pages, ["https://maker.test/"]);
  assert.deepEqual(served.hosts, [seenAt({ sitemap: "html" })]);
  // Every location on a host the record does not claim, as pulsetech.net listing pulsetech.com.
  const moved = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.example/a", "https://maker.example/b"),
  });
  const listed = await discoverPages(["maker.test"], moved.get);
  assert.deepEqual(listed.pages, ["https://maker.test/"]);
  assert.deepEqual(listed.hosts, [
    seenAt({ listed: 2, own: 0, listedElsewhere: ["maker.example"] }),
  ]);
});

test("a host that never answers gets both its home pages tried, and every refusal is counted", async () => {
  const none = site({
    "https://maker.test/sitemap.xml": { status: 0 },
    "https://www.maker.test/sitemap.xml": { status: 0 },
  });
  const silent = await discoverPages(["maker.test"], none.get);
  assert.deepEqual(silent.pages, ["https://maker.test/", "https://www.maker.test/"]);
  assert.deepEqual(silent.hosts, [
    seenAt({ host: "www.maker.test", status: 0, sitemap: "none", requests: 2, silent: 2 }),
  ]);
  const refusing = site({
    "https://maker.test/sitemap.xml": { status: 403 },
    "https://www.maker.test/sitemap.xml": { status: 403 },
  });
  const refused = await discoverPages(["maker.test"], refusing.get);
  assert.deepEqual(refused.hosts, [
    seenAt({ host: "www.maker.test", status: 403, sitemap: "none", requests: 2, refused: 2 }),
  ]);
  const www = site({});
  assert.deepEqual((await discoverPages(["www.maker.test"], www.get)).pages, [
    "https://www.maker.test/",
  ]);
  assert.deepEqual(www.asked, ["https://www.maker.test/sitemap.xml"]);
  // A subdomain is a site of its own; `www.` in front of it is nobody's name.
  const sub = site({});
  assert.deepEqual((await discoverPages(["power.maker.test"], sub.get)).pages, [
    "https://power.maker.test/",
  ]);
  assert.deepEqual(sub.asked, ["https://power.maker.test/sitemap.xml"]);
  assert.deepEqual(hostsToTry("maker.test"), ["maker.test", "www.maker.test"]);
  // An apex under a public second level is still an apex; a real subdomain is not.
  assert.deepEqual(hostsToTry("maker.co.uk"), ["maker.co.uk", "www.maker.co.uk"]);
  assert.deepEqual(hostsToTry("maker.com.au"), ["maker.com.au", "www.maker.com.au"]);
  assert.deepEqual(hostsToTry("power.maker.test"), ["power.maker.test"]);
  assert.deepEqual(hostsToTry("www.maker.test"), ["www.maker.test"]);
});

test("a sitemap request that lands on a host the record does not claim says where it went", async () => {
  // kohlerenergy.com answers every request with a redirect to www.rehlko.com.
  const { get } = site({
    "https://maker.test/sitemap.xml": {
      url: "https://www.newname.test/sitemap.xml",
      text: urlset("https://www.newname.test/a"),
    },
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(
    pages,
    ["https://maker.test/"],
    "nothing it lists is the maker's, so the home page",
  );
  assert.deepEqual(hosts, [
    seenAt({
      listed: 1,
      own: 0,
      redirectedTo: ["www.newname.test"],
      rootRedirectedTo: ["www.newname.test"],
      listedElsewhere: ["www.newname.test"],
    }),
  ]);
});

test("an index is opened up to its cap, a child that fails is counted, and CDATA locations count", async () => {
  const children = Array.from(
    { length: MAX_CHILD_SITEMAPS + 2 },
    (_, i) => `https://maker.test/sitemap-${i}.xml`,
  );
  const answers: Record<string, Answer> = {
    "https://maker.test/sitemap.xml": index(...children),
    "https://maker.test/sitemap-0.xml": `<urlset><url><loc><![CDATA[https://maker.test/product/cdata]]></loc></url></urlset>`,
    "https://maker.test/sitemap-1.xml": { status: 403 },
  };
  for (let i = 2; i < children.length; i += 1)
    answers[children[i]] = urlset(`https://maker.test/page-${i}`);
  const { get, asked } = site(answers);
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.ok(pages.includes("https://maker.test/product/cdata"));
  assert.ok(pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS - 1}`));
  assert.ok(!pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS}`));
  assert.ok(asked.includes("https://maker.test/sitemap-1.xml"));
  assert.ok(!pages.includes("https://maker.test/"));
  assert.deepEqual(hosts, [
    seenAt({
      sitemap: "index",
      listed: MAX_CHILD_SITEMAPS - 1,
      own: MAX_CHILD_SITEMAPS - 1,
      requests: 1 + MAX_CHILD_SITEMAPS,
      refused: 1,
      childrenFailed: 1,
      childrenSkipped: 2,
    }),
  ]);
});

test("a child that answers with a page instead of a sitemap is a child that could not be read", async () => {
  const { get } = site({
    "https://maker.test/sitemap.xml": index(
      "https://maker.test/a-sitemap.xml",
      "https://maker.test/b-sitemap.xml",
      "https://maker.test/nested-index.xml",
    ),
    "https://maker.test/a-sitemap.xml": urlset("https://maker.test/product/a"),
    // A consent page or a bot challenge, served with a 200.
    "https://maker.test/b-sitemap.xml": home,
    // An index inside the index: its two sitemaps are not pages, and are not opened.
    "https://maker.test/nested-index.xml": index(
      "https://maker.test/deep-1.xml",
      "https://maker.test/deep-2.xml",
    ),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a"]);
  assert.deepEqual([hosts[0]?.childrenFailed, hosts[0]?.childrenSkipped], [1, 2]);
});

test("an index's child on a host the record does not claim is never opened, and one that moves there is reported", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": index(
      "https://cdn.other.test/maker-sitemap.xml",
      "https://maker.test/product-sitemap.xml",
      "https://maker.test/moved-sitemap.xml",
    ),
    "https://cdn.other.test/maker-sitemap.xml": urlset("https://maker.test/leaked"),
    "https://maker.test/product-sitemap.xml": urlset("https://maker.test/product/a"),
    "https://maker.test/moved-sitemap.xml": {
      url: "https://www.newname.test/sitemap.xml",
      text: urlset("https://www.newname.test/b"),
    },
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a"]);
  assert.ok(!asked.includes("https://cdn.other.test/maker-sitemap.xml"));
  assert.deepEqual(hosts[0]?.redirectedTo, ["www.newname.test"]);
  assert.deepEqual(hosts[0]?.rootRedirectedTo, [], "a child that moved is not the site moving");
  assert.deepEqual([hosts[0]?.requests, hosts[0]?.listed, hosts[0]?.own], [3, 2, 1]);
  assert.equal(
    hosts[0]?.childrenSkipped,
    1,
    "the child on another host is a sitemap left unopened",
  );
});

test("two domains are read one after the other, and a page listed by both is one page", async () => {
  const { get } = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.test/a", "https://files.maker.test/b"),
    "https://files.maker.test/sitemap.xml": urlset("https://files.maker.test/b"),
  });
  const { pages, hosts } = await discoverPages(["maker.test", "files.maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/a", "https://files.maker.test/b"]);
  assert.deepEqual(
    hosts.map((h) => h.domain),
    ["maker.test", "files.maker.test"],
  );
});

test("pages give their own document links with the page they were on, and the rest once each by host", async () => {
  const { get } = site({
    "https://maker.test/product/a": `<a href="/files/a.pdf">datasheet</a><a href="https://cdn.shop.test/s/files/1/a-manual.pdf">manual</a><a href="https://cdn.shop.test/s/files/1/a-cert.pdf">cert</a>`,
    "https://maker.test/product/b": `<a href="https://maker.test/files/a.pdf">same datasheet</a><a href="https://cdn.shop.test/s/files/1/a-manual.pdf">manual again</a>`,
  });
  const read = await readPages(
    ["https://maker.test/product/a", "https://maker.test/product/b"],
    ["maker.test"],
    get,
  );
  assert.deepEqual(read.links, [
    {
      url: "https://maker.test/files/a.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/product/a",
    },
    {
      url: "https://maker.test/files/a.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/product/b",
    },
  ]);
  assert.deepEqual(
    [read.read, read.failed, read.foreign, read.redirectedTo],
    [
      2,
      {},
      {
        "cdn.shop.test": [
          "https://cdn.shop.test/s/files/1/a-cert.pdf",
          "https://cdn.shop.test/s/files/1/a-manual.pdf",
        ],
      },
      [],
    ],
  );
});

test("a page that will not load is counted by what it answered, and costs nothing else", async () => {
  const { get } = site({
    "https://maker.test/a": { status: 403 },
    "https://maker.test/b": { status: 0 },
    "https://maker.test/c": { status: 403 },
    "https://maker.test/d": `<a href="/d.pdf">d</a>`,
  });
  const read = await readPages(
    [
      "https://maker.test/a",
      "https://maker.test/b",
      "https://maker.test/c",
      "https://maker.test/d",
    ],
    ["maker.test"],
    get,
  );
  assert.equal(read.read, 1);
  assert.deepEqual(read.failed, { "403": 2, "0": 1 });
  assert.deepEqual(
    read.links.map((f) => f.url),
    ["https://maker.test/d.pdf"],
  );
});

test("a page that answers with a document is offered as that document, and its body is never parsed", async () => {
  const { get } = site({
    // A cited page that redirects to a PDF with no suffix in its address.
    "https://maker.test/sell-sheets/vue3": {
      url: "https://cdn.other.test/files/vue3",
      contentType: "application/pdf",
      text: '%PDF-1.7 <a href="/not/a/link.pdf">',
    },
    "https://maker.test/manual": { url: "https://maker.test/files/manual.pdf" },
    "https://maker.test/page": {
      contentType: "text/html; charset=utf-8",
      text: `<a href="/a.pdf">a</a>`,
    },
    // A download route with no suffix, answering a spreadsheet as text.
    "https://maker.test/export?id=manual": { contentType: "text/csv", text: "a,b\\n1,2" },
    // A file the host sends to be saved, whatever it calls it.
    "https://maker.test/save": { contentType: "text/html", attachment: true, text: "<p>x</p>" },
    // An image at a page-looking address is neither a page nor a document.
    "https://maker.test/logo": { contentType: "image/png", text: "PNG" },
  });
  const read = await readPages(
    [
      "https://maker.test/sell-sheets/vue3",
      "https://maker.test/manual",
      "https://maker.test/page",
      "https://maker.test/export?id=manual",
      "https://maker.test/save",
      "https://maker.test/logo",
    ],
    ["maker.test"],
    get,
  );
  assert.deepEqual(read.links, [
    {
      url: "https://maker.test/files/manual.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/manual",
    },
    { url: "https://maker.test/a.pdf", host: "maker.test", foundOn: "https://maker.test/page" },
    {
      url: "https://maker.test/export?id=manual",
      host: "maker.test",
      foundOn: "https://maker.test/export?id=manual",
    },
    { url: "https://maker.test/save", host: "maker.test", foundOn: "https://maker.test/save" },
  ]);
  assert.deepEqual(read.foreign, { "cdn.other.test": ["https://cdn.other.test/files/vue3"] });
  assert.deepEqual([read.read, read.opened], [1, ["https://maker.test/page"]]);
  assert.deepEqual(read.failed, { "not a page (image/png)": 1 });
  assert.equal(
    isDocumentAnswer({
      status: 200,
      url: "https://maker.test/x",
      text: "",
      contentType: "image/png",
    }),
    false,
  );
  assert.equal(
    isDocumentAnswer({
      status: 200,
      url: "https://maker.test/x",
      text: "",
      contentType: "text/plain",
    }),
    true,
  );
  assert.equal(isPage({ status: 200, url: "https://maker.test/x", text: "" }), true);
  assert.equal(
    isPage({ status: 200, url: "https://maker.test/x", text: "", contentType: "application/xml" }),
    true,
  );
  assert.equal(
    isPage({ status: 200, url: "https://maker.test/x", text: "", contentType: "application/zip" }),
    false,
  );
});

test("a page that lands on another site is a site that moved, and its links belong to where it landed", async () => {
  const { get } = site({
    "https://maker.test/": {
      url: "https://www.newname.test/",
      text: `<a href="/support/manual.pdf">manual</a>`,
    },
  });
  const read = await readPages(["https://maker.test/"], ["maker.test"], get);
  assert.deepEqual(read.redirectedTo, ["www.newname.test"]);
  assert.deepEqual(read.links, [], "a relative link resolves against the page's real address");
  assert.deepEqual(read.foreign, {
    "www.newname.test": ["https://www.newname.test/support/manual.pdf"],
  });
});

test("a sitemap served as plain text is read, while a plain-text download is not", async (t) => {
  const answers: Record<string, [string, string]> = {
    "https://maker.test/sitemap.xml": ["text/plain", urlset("https://maker.test/a")],
    "https://maker.test/export?id=manual": ["text/plain", "a,b\n1,2"],
    "https://maker.test/page": ["text/html", "<p>hi</p>"],
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [type, body] = answers[url] ?? ["text/plain", ""];
    return new Response(body, { status: 200, headers: { "content-type": type } });
  });
  assert.match((await fetchPage("https://maker.test/sitemap.xml")).text, /<urlset>/);
  assert.equal((await fetchPage("https://maker.test/export?id=manual")).text, "");
  assert.equal((await fetchPage("https://maker.test/page")).text, "<p>hi</p>");
});
