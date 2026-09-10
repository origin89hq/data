import { useState } from "react";
import { Section } from "./chrome.tsx";

/**
 * The snippets are written against the live origin, so a reader can copy one and it works. Anything
 * hard-coded here would be a URL to keep in step with the endpoint by hand.
 */
const snippets = (origin: string): Record<string, string> => ({
  duckdb: `-- Nothing to download. DuckDB reads the Parquet over HTTP.
SELECT m.name AS model, s.name AS figure, s.value, s.unit
FROM read_parquet('${origin}/v1/specs.parquet') s
JOIN read_parquet('${origin}/v1/models.parquet') m ON m.id = s.model_id
WHERE s.tier = 'reviewed' AND s.doubt IS NULL
LIMIT 20;`,
  python: `# pip install duckdb
import duckdb

df = duckdb.sql("""
  SELECT model_id, name, value, unit
  FROM read_parquet('${origin}/v1/specs.parquet')
  WHERE tier = 'reviewed' AND unit = 'Ah'
""").df()
print(df.head())`,
  pandas: `# pip install pandas pyarrow
import pandas as pd

specs = pd.read_parquet("${origin}/v1/specs.parquet")
makers = pd.read_parquet("${origin}/v1/manufacturers.parquet")

# How many models state a current anywhere?
print(specs[specs.unit == "A"].model_id.nunique())`,
  curl: `# the index says what is published, with a hash for every file
curl -s ${origin}/ | jq '.files | keys'

# a table
curl -O ${origin}/v1/specs.parquet

# a maker's mark, at 64, 128 or 256
curl -O ${origin}/logos/victron-energy-128.png`,
  javascript: `// The tables are plain HTTP with CORS open, so a browser can read them.
const index = await fetch("${origin}/").then((r) => r.json());
console.log(index.files["specs.parquet"].rows);

// Or query them with duckdb-wasm, which is what the console above does.`,
});

export function Usage({ origin }: { origin: string }) {
  const all = snippets(origin);
  const [tab, setTab] = useState("duckdb");
  return (
    <Section id="build" eyebrow="Integrate" title={<>Your stack.<br />Your next idea.</>}>
      <div className="mb-3.5 flex flex-wrap gap-1">
        {Object.keys(all).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`cursor-pointer border px-3 py-1.5 font-mono text-[12.5px] ${
              tab === name ? "border-action bg-surface-raised text-fg" : "border-line text-muted hover:text-fg"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <pre className="m-0 overflow-x-auto border border-line bg-surface p-4 font-mono text-[13px] leading-relaxed text-fg">
        {all[tab]}
      </pre>
    </Section>
  );
}

export function Licence() {
  return (
    <Section eyebrow="Terms" title="What you may do with it">
      <p className="max-w-[68ch] text-muted">
        <strong className="font-semibold text-fg">MIT</strong>, for the tooling and the records alike. Attribution is
        welcome and not required.
      </p>
      <div className="mt-5 grid gap-7 md:grid-cols-2">
        <div className="border border-line border-l-2 border-l-nominal bg-surface px-6 py-5">
          <h3 className="mb-2 text-[17px] font-semibold">You can</h3>
          <ul className="m-0 list-disc pl-4.5 text-[14.5px] text-muted">
            <li className="mb-1.5">Use it commercially, in a product you sell.</li>
            <li className="mb-1.5">Copy, modify and redistribute the tables.</li>
            <li className="mb-1.5">Build a competing dataset from it.</li>
            <li className="mb-1.5">Ship it inside a closed-source application.</li>
          </ul>
        </div>
        <div className="border border-line border-l-2 border-l-alarm bg-surface px-6 py-5">
          <h3 className="mb-2 text-[17px] font-semibold">You cannot</h3>
          <ul className="m-0 list-disc pl-4.5 text-[14.5px] text-muted">
            <li className="mb-1.5">Treat the logos as MIT. They are trademarks, served to identify a maker.</li>
            <li className="mb-1.5">Hold anyone liable. There is no warranty, and equipment ratings matter.</li>
            <li className="mb-1.5">Assume a figure is right. Most were read by a model from a maker's PDF.</li>
            <li className="mb-1.5">Size anything for safety without opening the source document it names.</li>
          </ul>
        </div>
      </div>
      <p className="mt-6 max-w-[68ch] border-l-2 border-warning pl-4 text-[14.5px] text-muted">
        Two tiers sit in one table. <code className="bg-[var(--journal-field)] px-1.5 py-0.5 font-mono text-[12.5px] text-fg">tier = 'reviewed'</code>{" "}
        is read from a maker's own document and carries its source and page.{" "}
        <code className="bg-[var(--journal-field)] px-1.5 py-0.5 font-mono text-[12.5px] text-fg">tier = 'feed'</code> comes
        from a public dataset redistributed under its own licence. Filter on it.
      </p>
    </Section>
  );
}
