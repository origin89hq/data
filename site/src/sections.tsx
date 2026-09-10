import { useState } from "react";
import { count, kb, type Index, type Maker } from "./api.ts";
import { Eyebrow, Section } from "./chrome.tsx";
import { useDuckDb, type Query } from "./useDuckDb.ts";

export function Makers({ makers }: { makers: Maker[] }) {
  const withLogo = makers.filter((maker) => maker.logo);
  return (
    <Section eyebrow="Makers" title="Every company in the set">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5">
        {withLogo.map((maker) => (
          <a
            key={maker.id}
            href={maker.website ?? "#"}
            title={maker.name}
            className="maker-tile flex aspect-square items-center justify-center border border-line p-3.5 transition-transform hover:-translate-y-0.5"
          >
            <img src={maker.logo} alt={maker.name} loading="lazy" className="max-h-full max-w-full object-contain" />
          </a>
        ))}
        <div className="flex aspect-square items-center justify-center border border-dashed border-line text-center font-mono text-[12px] text-faint">
          +{makers.length - withLogo.length}
          <br />
          no mark
        </div>
      </div>
      <p className="mt-6 max-w-[68ch] border-l-2 border-warning pl-4 text-[14.5px] text-muted">
        A maker's mark is its trademark, not part of the MIT grant. They are served here to identify the maker. For any
        other use, ask the maker.
      </p>
    </Section>
  );
}

export function Tables({ index }: { index?: Index }) {
  const files = Object.keys(index?.files ?? {})
    .filter((file) => file.endsWith(".parquet"))
    .sort((a, b) => (index?.files[b]?.rows ?? 0) - (index?.files[a]?.rows ?? 0));
  return (
    <Section eyebrow="Tables" title="Take what you need">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Table", "Rows", "Parquet", "CSV"].map((head) => (
                <th key={head} className="border-b border-line pr-3.5 pb-2.5 text-left text-[11px] font-medium tracking-[0.1em] text-faint uppercase">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
              const name = file.replace(".parquet", "");
              const parquet = index?.files[file];
              const csv = index?.files[`${name}.csv`];
              return (
                <tr key={name}>
                  <td className="border-b border-line py-2.5 pr-3.5 font-mono">{name}</td>
                  <td className="border-b border-line py-2.5 pr-3.5 text-right font-mono">{count(parquet?.rows ?? 0)}</td>
                  <td className="border-b border-line py-2.5 pr-3.5">
                    <a className="text-link hover:underline" href={parquet?.url}>{kb(parquet?.bytes ?? 0)}</a>
                  </td>
                  <td className="border-b border-line py-2.5 pr-3.5">
                    {csv ? <a className="text-link hover:underline" href={csv.url}>{kb(csv.bytes)}</a> : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

const EXAMPLES: Record<string, string> = {
  "figures by unit": "SELECT unit, count(*) AS figures\nFROM specs\nWHERE tier = 'reviewed' AND unit IS NOT NULL\nGROUP BY 1 ORDER BY 2 DESC LIMIT 15;",
  "best covered models": "SELECT m.manufacturer_id, m.name, count(*) AS figures\nFROM specs s JOIN models m ON m.id = s.model_id\nWHERE s.tier = 'reviewed'\nGROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15;",
  "battery capacities": "SELECT model_id, value, unit, name\nFROM specs\nWHERE unit = 'Ah' AND tier = 'reviewed'\nORDER BY try_cast(value AS DOUBLE) DESC NULLS LAST\nLIMIT 20;",
  "protocols and drivers": "SELECT family, driver_status, count(*) AS dialects\nFROM dialects\nGROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15;",
  "makers with a mark": "SELECT id, name, logo_from, logo_widths\nFROM manufacturers WHERE logo IS NOT NULL\nORDER BY id LIMIT 20;",
};

export function Console({ index }: { index?: Index }) {
  const db = useDuckDb(index);
  const [sql, setSql] = useState(EXAMPLES["figures by unit"]!);
  // What the last run produced: a result, a refusal, or nothing yet. Derived into a line below
  // rather than kept as a second copy of the same fact — setting state while rendering converges
  // here but only by luck, and it warns in strict mode.
  const [outcome, setOutcome] = useState<{ result?: Query; error?: string }>({});
  const [running, setRunning] = useState(false);

  const run = async (query = sql) => {
    if (!db.ready) return;
    setRunning(true);
    try {
      setOutcome({ result: await db.run(query) });
    } catch (error) {
      setOutcome({ error: String(error).replace(/^Error: /, "").slice(0, 160) });
    }
    setRunning(false);
  };

  const broken = Boolean(outcome.error) || (!db.ready && Boolean(db.error));
  const status = running
    ? "running…"
    : (outcome.error ??
      (outcome.result
        ? `${outcome.result.rows.length}${outcome.result.rows.length === 500 ? "+" : ""} rows in ${outcome.result.ms.toFixed(0)} ms`
        : db.ready
          ? `${db.tables.length} tables ready`
          : db.error
            ? `DuckDB did not load: ${db.error}`
            : "loading DuckDB…"));
  const result = outcome.result;

  return (
    <Section id="explore" eyebrow="Explorer" title={<>Find the equipment.<br />See what is documented.</>}>
      <p className="max-w-[68ch] text-muted">
        DuckDB runs in this page and reads the Parquet straight off this domain over HTTP range requests. Nothing is
        uploaded, nothing is proxied, and the same query works on your machine.
      </p>
      <div className="mt-5 flex flex-wrap gap-1.5">
        {Object.keys(EXAMPLES).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              setSql(EXAMPLES[name]!);
              void run(EXAMPLES[name]!);
            }}
            className="cursor-pointer border border-line bg-surface-raised px-2.5 py-1 font-mono text-[12px] text-muted hover:border-action hover:text-fg"
          >
            {name}
          </button>
        ))}
      </div>
      <textarea
        value={sql}
        spellCheck={false}
        onChange={(event) => setSql(event.target.value)}
        className="mt-3 min-h-[108px] w-full resize-y border border-line bg-surface p-4 font-mono text-[13px] text-fg focus:border-action focus:outline-none"
      />
      <div className="my-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={!db.ready || running}
          onClick={() => void run()}
          className="cursor-pointer border border-action px-5 py-2 text-sm text-fg hover:bg-[var(--journal-field)] disabled:cursor-default disabled:opacity-45"
        >
          Run
        </button>
        <span className={`font-mono text-[13px] ${broken ? "text-alarm" : "text-faint"}`}>{status}</span>
      </div>
      {result && (
        <div className="mt-4 max-h-[460px] overflow-auto border border-line">
          <table className="w-full border-collapse font-mono text-[12.5px]">
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column} className="sticky top-0 bg-surface-raised px-3.5 py-2.5 text-left text-faint">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map((column) => (
                    <td key={column} className="border-b border-line px-3.5 py-1.5 whitespace-nowrap">
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
