import { useEffect, useState } from "react";
import buddy from "@origin89/brand/art/avatar-welcoming.webp";
import { count, type Index } from "./api.ts";
import { Eyebrow, Section, WRAP } from "./chrome.tsx";
import { useDuckDb } from "./useDuckDb.ts";

interface Figure {
  model_id: string;
  name: string;
  value: string;
  unit: string | null;
  page: number | null;
  url: string | null;
  extracted_by: string | null;
  reviewed_by: string | null;
  doubt: string | null;
}

/**
 * One real figure, followed all the way back to the page it was read off.
 *
 * Fetched rather than written down. A worked example that quietly stopped matching the data would
 * be the most damaging paragraph on the page, since its whole argument is that the trail holds.
 */
export function Evidence({ index }: { index?: Index }) {
  const db = useDuckDb(index);
  const [figure, setFigure] = useState<Figure>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!db.ready) return;
    void db
      .run(`SELECT s.model_id, s.name, s.value, s.unit, s.page, o.url, s.extracted_by, s.reviewed_by, s.doubt
            FROM specs s JOIN sources o ON o.id = s.source_id
            WHERE s.tier = 'reviewed' AND s.doubt IS NULL AND s.page IS NOT NULL AND o.url IS NOT NULL
              AND s.unit IN ('Ah', 'kWh', 'V', 'A', 'W')
            ORDER BY s.model_id LIMIT 1`)
      .then((answer) => setFigure(answer.rows[0] as unknown as Figure))
      .catch(() => setFailed(true));
  }, [db]);

  return (
    <Section
      id="evidence"
      eyebrow="Provenance"
      title={<>A number is useful.<br />Its source is essential.</>}
      lede="Most of these figures were read by a model out of a maker's own PDF, and nobody has checked the row. That is worth knowing rather than hiding, so every figure carries where it came from and how."
    >
      <div className="mt-12 grid gap-px border border-line bg-line lg:grid-cols-3">
        {[
          ["Find the original source", "Each figure names a document and, where the reader could tell, the page. Open it and read the row yourself."],
          ["Know how the figure arrived", "`ai:` means a model read prose. `table:` means a parser read the maker's own specification table. Neither means a person checked it."],
          ["See what still needs checking", "A figure that is not a number with a real unit says so in `doubt`, rather than sitting in the table looking like the rest."],
        ].map(([title, body]) => (
          <div key={title} className="bg-page p-8">
            <h3 className="text-[19px]">{title}</h3>
            <p className="mt-3 text-[15px] text-muted">{body}</p>
          </div>
        ))}
      </div>

      {figure && (
        <figure className="mt-10 border border-line bg-surface p-8">
          <Eyebrow>A figure, followed back</Eyebrow>
          <h3 className="mt-3 font-mono text-[22px]">{figure.model_id}</h3>
          <p className="mt-5 font-mono text-[clamp(26px,3vw,34px)] text-fg">
            {figure.value} {figure.unit ?? ""}
          </p>
          <p className="mt-1 text-[15px] text-muted">{figure.name}</p>
          <dl className="mt-7 grid gap-6 border-t border-line pt-6 text-[14px] sm:grid-cols-3">
            <div>
              <dt className="font-mono text-[10px] tracking-[0.055em] text-muted uppercase">Read from</dt>
              <dd className="m-0 mt-1.5">
                <a className="break-all text-action hover:underline" href={figure.url ?? undefined}>
                  {(figure.url ?? "").split("/").pop()}
                </a>
                {figure.page !== null && <span className="text-muted">, page {figure.page}</span>}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] tracking-[0.055em] text-muted uppercase">Extracted by</dt>
              <dd className="m-0 mt-1.5 font-mono text-[13px] break-all">{figure.extracted_by ?? "—"}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] tracking-[0.055em] text-muted uppercase">Confirmed by</dt>
              <dd className="m-0 mt-1.5">{figure.reviewed_by ?? <span className="text-muted">nobody yet</span>}</dd>
            </div>
          </dl>
        </figure>
      )}
      {failed && <p className="mt-8 text-[15px] text-muted">The worked example could not be read just now; the tables below are unaffected.</p>}
    </Section>
  );
}

interface CoverageRow {
  kind: string;
  models: number;
}

/** What the dataset holds and, as plainly, where it does not. */
export function Coverage({ index }: { index?: Index }) {
  const db = useDuckDb(index);
  const [rows, setRows] = useState<CoverageRow[]>([]);

  useEffect(() => {
    if (!db.ready) return;
    // The reviewed tier only. The public feeds add twenty thousand panels whose kind comes with
    // them, and counting those here would bury what this project has actually classified.
    void db
      .run(`SELECT coalesce(kind, 'unclassified') AS kind, count(*) AS models
            FROM models WHERE tier = 'reviewed' GROUP BY 1 ORDER BY 2 DESC`)
      .then((answer) => setRows(answer.rows as unknown as CoverageRow[]))
      .catch(() => setRows([]));
  }, [db]);

  const largest = Math.max(1, ...rows.map((row) => Number(row.models)));
  return (
    <Section
      id="coverage"
      eyebrow="Coverage"
      title={<>See what is here.<br />And where the gaps are.</>}
      lede="Models this project classified itself, which is the part it can answer for. The public feeds it redistributes bring twenty thousand more with their own labels attached. Nothing is padded to look complete: a product nobody has classified is counted as unclassified rather than filed under a guess."
    >
      <div className="mt-12 border border-line bg-page">
        {rows.map((row) => (
          <div key={row.kind} className="flex items-center gap-5 border-b border-line px-6 py-3 last:border-b-0">
            <span className={`w-48 shrink-0 text-[14px] ${row.kind === "unclassified" ? "text-muted italic" : ""}`}>{row.kind}</span>
            <span className="h-2 bg-action" style={{ width: `${(Number(row.models) / largest) * 100}%` }} aria-hidden />
            <span className="ml-auto font-mono text-[13px] text-muted">{count(Number(row.models))}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="m-0 px-6 py-8 text-[15px] text-muted">Counting…</p>}
      </div>
    </Section>
  );
}

/** Buddy says the thing a reader most needs told, in the voice that has to live with it. */
export function BuddyNote() {
  return (
    <section className="border-t border-line py-[86px]">
      <div className={WRAP}>
        <div className="flex flex-col gap-9 sm:flex-row sm:items-start">
          <img src={buddy} alt="Buddy, the Origin89 assistant" width={116} height={116} className="size-29 shrink-0" />
          <div>
            <Eyebrow>A word before you size anything</Eyebrow>
            <h2 className="mt-4 max-w-[16ch] text-[clamp(30px,3.2vw,42px)]">
              You do not need to know
              <br />
              where to look.
            </h2>
            <p className="mt-5 max-w-[58ch] text-[17px] text-muted">
              Most of these figures were read by a model out of a maker's own PDF, and nobody has checked the row. The{" "}
              <code className="bg-[var(--journal-field)] px-1.5 py-0.5 font-mono text-[13px] text-fg">doubt</code> column
              says when a figure is not a number with a real unit, and every reviewed row names the document and the page
              it came from. Open the document before you trust the number. I have to, and I live here.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
