import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverPages, hostsToTry, MAX_CHILD_SITEMAPS } from "../src/discover.ts";

const urlset = (...urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;
const home = "<!doctype html><html><body>home</body></html>";

/** A site answering from a table of urls, refusing everything else, and remembering what was asked. */
function site(answers: Record<string, string>) {
  const asked: string[] = [];
  const get = async (url: string): Promise<string> => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new Error(`${url}: HTTP 404`);
    return answer;
  };
  return { get, asked };
}

test("a sitemap's own pages are the pages, and nothing else is knocked on", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": urlset(
      "https://maker.test/product/a",
      "https://maker.test/product/b",
      "https://reseller.test/maker-a",
    ),
  });
  assert.deepEqual(await discoverPages(["maker.test"], get), [
    "https://maker.test/product/a",
    "https://maker.test/product/b",
  ]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml"]);
});

test("when the bare host does not answer, the www host is asked, and its home page is the fallback", async () => {
  const { get, asked } = site({
    "https://www.maker.test/sitemap.xml": urlset("https://www.maker.test/product/a"),
  });
  assert.deepEqual(await discoverPages(["maker.test"], get), ["https://www.maker.test/product/a"]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml", "https://www.maker.test/sitemap.xml"]);
  // A www host whose sitemap is an HTML page falls back to that host's home, not the bare one.
  const html = site({ "https://www.maker.test/sitemap.xml": home });
  assert.deepEqual(await discoverPages(["maker.test"], html.get), ["https://www.maker.test/"]);
});

test("a sitemap that answers with no page on the maker's hosts falls back to the home page", async () => {
  // The HTML home page served at /sitemap.xml, as progressivedyn.com and southwire.com do.
  const page = site({ "https://maker.test/sitemap.xml": home });
  assert.deepEqual(await discoverPages(["maker.test"], page.get), ["https://maker.test/"]);
  // Every location on a host the record does not claim, as pulsetech.net listing pulsetech.com.
  const moved = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.example/a", "https://maker.example/b"),
  });
  assert.deepEqual(await discoverPages(["maker.test"], moved.get), ["https://maker.test/"]);
});

test("a host that never answers gets both its home pages tried, and a www domain only its own", async () => {
  const none = site({});
  assert.deepEqual(await discoverPages(["maker.test"], none.get), [
    "https://maker.test/",
    "https://www.maker.test/",
  ]);
  assert.deepEqual(none.asked, [
    "https://maker.test/sitemap.xml",
    "https://www.maker.test/sitemap.xml",
  ]);
  const www = site({});
  assert.deepEqual(await discoverPages(["www.maker.test"], www.get), ["https://www.maker.test/"]);
  assert.deepEqual(www.asked, ["https://www.maker.test/sitemap.xml"]);
  // A subdomain is a site of its own; `www.` in front of it is nobody's name.
  const sub = site({});
  assert.deepEqual(await discoverPages(["power.maker.test"], sub.get), [
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

test("an index's child on a host the record does not claim is never opened", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": index(
      "https://cdn.other.test/maker-sitemap.xml",
      "https://maker.test/product-sitemap.xml",
    ),
    "https://cdn.other.test/maker-sitemap.xml": urlset("https://maker.test/leaked"),
    "https://maker.test/product-sitemap.xml": urlset("https://maker.test/product/a"),
  });
  assert.deepEqual(await discoverPages(["maker.test"], get), ["https://maker.test/product/a"]);
  assert.ok(!asked.includes("https://cdn.other.test/maker-sitemap.xml"));
});

test("an index is opened up to its cap, a child that fails costs only itself, and CDATA locations count", async () => {
  const children = Array.from(
    { length: MAX_CHILD_SITEMAPS + 2 },
    (_, i) => `https://maker.test/sitemap-${i}.xml`,
  );
  const answers: Record<string, string> = {
    "https://maker.test/sitemap.xml": index(...children),
    "https://maker.test/sitemap-0.xml": `<urlset><url><loc><![CDATA[https://maker.test/product/cdata]]></loc></url></urlset>`,
  };
  for (let i = 2; i < children.length; i += 1)
    answers[children[i]] = urlset(`https://maker.test/page-${i}`);
  const { get, asked } = site(answers);
  const pages = await discoverPages(["maker.test"], get);
  assert.ok(pages.includes("https://maker.test/product/cdata"));
  assert.ok(pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS - 1}`));
  assert.ok(!pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS}`));
  assert.ok(asked.includes("https://maker.test/sitemap-1.xml"));
  assert.ok(!pages.includes("https://maker.test/"));
});

test("two domains are read one after the other, and a page listed by both is one page", async () => {
  const { get } = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.test/a", "https://files.maker.test/b"),
    "https://files.maker.test/sitemap.xml": urlset("https://files.maker.test/b"),
  });
  assert.deepEqual(await discoverPages(["maker.test", "files.maker.test"], get), [
    "https://maker.test/a",
    "https://files.maker.test/b",
  ]);
});
