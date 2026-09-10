import { useEffect, useState } from "react";
import { count, type Index } from "./api.ts";
import { useDuckDb } from "./useDuckDb.ts";

const A = "assets";

interface Trail {
  model_id: string;
  name: string;
  value: string;
  unit: string | null;
  page: number | null;
  url: string | null;
  title: string | null;
  confidence: string | null;
  extracted_by: string | null;
  reviewed_by: string | null;
}

/**
 * A real figure followed back to the page it was read off.
 *
 * The draft wrote its example into the page. This one is queried, because an example that quietly
 * stopped matching the data would be the most damaging paragraph here: the whole section argues
 * that the trail holds.
 */
export function Evidence({ index }: { index?: Index }) {
  const db = useDuckDb(index);
  const [trail, setTrail] = useState<Trail>();

  useEffect(() => {
    if (!db.ready) return;
    void db
      .run(`SELECT s.model_id, s.name, s.value, s.unit, s.page, o.url, o.title,
                   s.confidence, s.extracted_by, s.reviewed_by
            FROM specs s JOIN sources o ON o.id = s.source_id
            WHERE s.tier = 'reviewed' AND s.doubt IS NULL AND s.page IS NOT NULL
              AND o.url IS NOT NULL AND s.unit = 'Ah'
            ORDER BY try_cast(s.value AS DOUBLE) DESC NULLS LAST LIMIT 1`)
      .then((answer) => setTrail(answer.rows[0] as unknown as Trail))
      .catch(() => undefined);
  }, [db]);

  return (
    <section id="evidence" className="section wrap evidence-section">
      <div className="evidence-story">
        <p className="eyebrow">03 / THE EVIDENCE COMES WITH IT</p>
        <h2>A number is useful.<br /><span className="accent-text">Its source is essential.</span></h2>
        <p>A battery’s capacity means little without its conditions. A protocol claim needs more than a familiar connector. Keep the context with the claim.</p>
        <ol className="evidence-steps">
          <li><span>01</span><div><h3>Find the original source</h3><p>Document links and page references, where available.</p></div></li>
          <li><span>02</span><div><h3>Know how the figure arrived</h3><p>Public feed, automated extraction, or human review.</p></div></li>
          <li><span>03</span><div><h3>See what still needs checking</h3><p>Confidence, reviewer, and doubt fields stay visible.</p></div></li>
        </ol>
        <a className="text-link" href="#explore">Inspect an actual record <span aria-hidden>↗</span></a>
      </div>
      <div className="provenance-card">
        <div className="panel-cap"><span>SPECIFICATION / SOURCE TRAIL</span><span>↗</span></div>
        <div className="provenance-main">
          <span className="eyebrow">{(trail?.model_id ?? "").split("-")[0]?.toUpperCase() || "MANUFACTURER"}</span>
          <h3>{trail?.model_id ?? "—"}</h3>
          <div className="big-reading">{trail?.value ?? "—"}<span>{trail?.unit ?? ""}</span></div>
          <span className="reading-label">{trail?.name ?? "Capacity"} · as stated in source</span>
          <div className="source-document">
            <span className="document-symbol">PDF</span>
            <div>
              <strong>{trail?.title ?? (trail?.url ?? "").split("/").pop() ?? "Manufacturer document"}</strong>
              <span>Original source{trail?.page ? ` · page ${trail.page}` : ""}</span>
            </div>
            {trail?.url && <a href={trail.url} target="_blank" rel="noopener" aria-label="Open the original manufacturer source">↗</a>}
          </div>
          <dl>
            <div><dt>Evidence</dt><dd>{trail?.confidence ?? "—"}</dd></div>
            <div><dt>Method</dt><dd>{trail?.extracted_by?.startsWith("table:") ? "Table parser" : trail?.extracted_by ? "Automated extraction" : "—"}</dd></div>
            <div><dt>Human review</dt><dd className="amber-text">{trail?.reviewed_by ?? "Not yet reviewed"}</dd></div>
          </dl>
        </div>
        <div className="buddy-note">
          <img src={`${A}/art/avatar-round.webp`} width="45" height="45" alt="Buddy" />
          <p>“I can point you to the page.<br />Check the original before sizing your system.”</p>
        </div>
      </div>
    </section>
  );
}

interface Family {
  family: string;
  entries: number;
  documented: number;
}

/** What the catalogue covers, and how much of it cites a maker's own document. */
export function Coverage({ index }: { index?: Index }) {
  const db = useDuckDb(index);
  const [families, setFamilies] = useState<Family[]>([]);
  const [mode, setMode] = useState<"count" | "documented">("count");
  const [confidences, setConfidences] = useState<{ confidence: string; dialects: number }[]>([]);

  useEffect(() => {
    if (!db.ready) return;
    void db
      .run(`SELECT d.family,
                   count(*) AS entries,
                   count(*) FILTER (WHERE d.id IN (SELECT dialect_id FROM dialect_sources)) AS documented
            FROM dialects d GROUP BY 1 ORDER BY 2 DESC`)
      .then((answer) => setFamilies(answer.rows as unknown as Family[]))
      .catch(() => setFamilies([]));
    void db
      .run(`SELECT confidence, count(*) AS dialects FROM dialects
            WHERE confidence IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)
      .then((answer) => setConfidences(answer.rows as unknown as { confidence: string; dialects: number }[]))
      .catch(() => setConfidences([]));
  }, [db]);

  const value = (row: Family) => Number(mode === "count" ? row.entries : row.documented);
  const largest = Math.max(1, ...families.map(value));
  const entries = families.reduce((n, row) => n + Number(row.entries), 0);
  const documented = families.reduce((n, row) => n + Number(row.documented), 0);

  return (
    <section className="section coverage-section">
      <div className="wrap">
        <div className="section-heading">
          <div>
            <p className="eyebrow">04 / A CLEAR VIEW OF COVERAGE</p>
            <h2>See what’s here.<br />And where the gaps are.</h2>
          </div>
          <p>Coverage is a starting point. Evidence quality and implementation status are separate questions.</p>
        </div>
        <div className="coverage-grid">
          <div className="coverage-chart">
            <div className="chart-heading">
              <h3>Protocol catalogue</h3>
              <div className="segmented" role="group" aria-label="Protocol coverage">
                <button aria-pressed={mode === "count"} onClick={() => setMode("count")}>All entries</button>
                <button aria-pressed={mode === "documented"} onClick={() => setMode("documented")}>Vendor docs</button>
              </div>
            </div>
            <p>{count(entries)} dialect entries across {families.length} catalogue families.</p>
            <div id="coverage-bars">
              {families.map((row) => (
                <div key={row.family} className="bar-row">
                  <span>{row.family}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(value(row) / largest) * 100}%` }} /></div>
                  <span className="bar-count">{count(value(row))}</span>
                </div>
              ))}
              {families.length === 0 && <p>Counting…</p>}
            </div>
            <div className="chart-foot"><span>Dialect entries · linear scale</span><span>Source: the published tables</span></div>
          </div>
          <div className="coverage-aside">
            <span className="eyebrow">EVIDENCE AT A GLANCE</span>
            <div className="coverage-number">{count(documented)}<span>/ {count(entries)}</span></div>
            <h3>dialects cite vendor documentation</h3>
            <p>Explore the reference behind a protocol before treating it as implemented or compatible.</p>
            <div className="confidence-list">
              {confidences.map((row) => (
                <div key={row.confidence}><span>{row.confidence}</span><strong>{count(Number(row.dialects))}</strong></div>
              ))}
            </div>
            <a className="text-link" href="#explore">Explore the protocols <span aria-hidden>↗</span></a>
          </div>
        </div>
      </div>
    </section>
  );
}
