import { useEffect, useState } from "react";
import { count, fetchIndex, type Index } from "./api.ts";
import { Explorer } from "./explorer.tsx";
import { Coverage, Evidence } from "./panels.tsx";
import { Build } from "./build.tsx";

const A = "assets";

/**
 * The data site, ported from the draft in `docs/design/data-origin89`.
 *
 * Its markup and its stylesheet are the draft's, unchanged where they could be. What differs is
 * where the numbers come from: the draft baked a snapshot into a JavaScript file so it could be
 * opened from disk, and this reads the same public endpoints anybody else would call. A page whose
 * argument is that every figure can be followed back cannot itself be a copy of what once was.
 */
export function Site() {
  const [index, setIndex] = useState<Index>();
  useEffect(() => {
    void fetchIndex().then(setIndex).catch(() => undefined);
  }, []);

  const rows = (table: string) => count(index?.files[`${table}.parquet`]?.rows ?? 0);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="site-header">
        <a className="identity" href="https://origin89.com" aria-label="Origin89 Data home">
          <img src={`${A}/logos/origin89-horizontal-blue.svg`} width="159" height="27" alt="Origin89" />
          <span className="identity-divider" />
          <span className="data-word">data</span>
        </a>
        <nav id="navigation" aria-label="Main navigation">
          <a href="#dataset">The dataset</a>
          <a href="#explore">Explore data</a>
          <a href="#build">For developers</a>
          <a className="nav-source" href="https://github.com/origin89hq/offgrid-equipment" target="_blank" rel="noopener">
            GitHub <span aria-hidden>↗</span>
          </a>
        </nav>
        <a className="button small nav-buddy" href="https://origin89.com" target="_blank" rel="noopener">
          <img src={`${A}/art/avatar-round.webp`} width="22" height="22" alt="" />
          Ask Buddy <span aria-hidden>↗</span>
        </a>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-intro wrap">
            <p className="eyebrow hero-eyebrow"><span className="little-dot" /> OPEN EQUIPMENT DATA / BY ORIGIN89</p>
            <h1 id="hero-title">A clearer picture<br /><span>of off-grid equipment.</span></h1>
            <p className="hero-copy">
              Solar from one brand. Batteries from another. The details, together.
              <br className="desktop-break" /> Find models, read the specifications, and follow each source.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#explore">Explore the dataset <span aria-hidden>↗</span></a>
              <a className="button quiet" href="#build">Build with the data <span aria-hidden>→</span></a>
            </div>
            <div className="open-note"><span>MIT licensed</span><span>No API key</span><span>Yours to build on</span></div>
          </div>

          <div className="data-flow wrap" aria-label="Manufacturer documents and protocol references connect to equipment records, delivered as open data.">
            <div className="flow-caption left-caption">FROM THE SOURCE</div>
            <div className="flow-caption right-caption">INTO YOUR NEXT IDEA</div>
            <svg className="flow-lines" viewBox="0 0 1120 268" preserveAspectRatio="none" aria-hidden>
              <defs>
                <linearGradient id="line-in"><stop stopColor="#2b343f" /><stop offset="1" stopColor="#6279ad" /></linearGradient>
                <linearGradient id="line-out"><stop stopColor="#6279ad" /><stop offset="1" stopColor="#2b343f" /></linearGradient>
              </defs>
              <g fill="none" stroke="url(#line-in)">
                <path d="M200 69H258Q275 69 292 93L334 134H390" />
                <path d="M230 139H390" />
                <path d="M200 209H258Q275 209 292 185L334 144H390" />
              </g>
              <g fill="none" stroke="url(#line-out)">
                <path d="M730 134H782L828 83Q840 69 858 69H920" />
                <path d="M730 139H900" />
                <path d="M730 144H782L828 196Q840 209 858 209H920" />
              </g>
              <g fill="#6279ad">
                <circle cx="390" cy="139" r="3" /><circle cx="730" cy="139" r="3" />
                <circle cx="269" cy="76" r="2.5" /><circle cx="846" cy="204" r="2.5" />
              </g>
            </svg>
            <div className="source-stack">
              <div className="flow-chip"><span className="file-icon">PDF</span><span>Manufacturer datasheets</span></div>
              <div className="flow-chip"><span className="file-icon">{"{ }"}</span><span>Protocol references</span></div>
              <div className="flow-chip"><span className="file-icon">≋</span><span>Public equipment libraries</span></div>
            </div>
            <HeroRecord />
            <div className="destination-stack">
              <div className="flow-chip"><span className="file-icon">↓</span><span>Parquet / CSV / JSON</span></div>
              <div className="flow-chip"><span className="file-icon">&gt;_</span><span>Your tools &amp; applications</span></div>
              <div className="flow-chip"><img src={`${A}/art/avatar-round.webp`} alt="" width="30" height="30" /><span>A little help from Buddy</span></div>
            </div>
          </div>

          <div className="stats-wrap wrap">
            <div className="stats">
              {[
                [rows("models"), "Equipment models"],
                [rows("specs"), "Specification rows"],
                [count(index?.counts?.dialects ?? 0), "Protocol dialects"],
                [rows("sources"), "Source records"],
              ].map(([value, label]) => (
                <div key={label} className="stat">
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className="snapshot-line">
              <span>One connected dataset. Many ways in.</span>
              <span>PUBLISHED AT <span className="snapshot-date">DATA.ORIGIN89.COM</span></span>
            </div>
          </div>
        </section>

        <section id="dataset" className="section wrap">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / THE DATASET</p>
              <h2>Different equipment.<br />Common ground.</h2>
            </div>
            <p>Solar panels to battery banks. Register maps to rated figures. The details that belong together, finally in one place.</p>
          </div>
          <div className="data-pillars">
            {[
              ["01", "Equipment identity", "Models, makers, aliases, and equipment types. A shared identity to connect your records.", `${rows("models")} MODELS`, "#explore"],
              ["02", "Specifications", "Rated figures with units, conditions, and their original source. Context stays attached.", `${rows("specs")} RATED FIGURES`, "#explore"],
              ["03", "Protocols & dialects", "Register maps, frame layouts, driver status, and the gotchas you want to know about.", `${count(index?.counts?.dialects ?? 0)} DIALECTS`, "#explore"],
              ["04", "Evidence & confidence", "Follow a claim back to its reference. See where it came from and what has been checked.", `${rows("sources")} SOURCE RECORDS`, "#evidence"],
            ].map(([number, title, body, foot, href]) => (
              <a key={number} className="pillar" href={href}>
                <span className="pillar-number">{number} <span>↗</span></span>
                <h3>{title}</h3>
                <p>{body}</p>
                <span className="pillar-foot">{foot}</span>
              </a>
            ))}
          </div>
        </section>

        <section id="explore" className="section explorer-section">
          <div className="wrap">
            <div className="section-heading">
              <div>
                <p className="eyebrow">02 / GET TO KNOW THE DATA</p>
                <h2>Find the equipment. See what’s documented.</h2>
              </div>
              <p>Start with a model. Inspect a figure.<br />Follow the evidence all the way back.</p>
            </div>
            <Explorer index={index} tier="reviewed" />
            <div className="explorer-helper">
              <span><span className="little-dot" /> Every record here is live from the published tables. Select a row to inspect it.</span>
            </div>
          </div>
        </section>

        <Evidence index={index} />
        <Coverage index={index} />
        <Build index={index} />
      </main>

      <footer className="closing wrap">
        <p>
          Built by <a href="https://origin89.com">Origin89</a> · <a href="https://github.com/origin89hq/offgrid-equipment">source on GitHub</a> ·{" "}
          <a href="mailto:hello@origin89.com">hello@origin89.com</a>
        </p>
        <p>Corrections are the most useful contribution. Every figure names its document, so a wrong one can be shown wrong.</p>
      </footer>
    </>
  );
}

/** The card at the centre of the hero: a real figure, fetched, with its page reference. */
function HeroRecord() {
  const [figure, setFigure] = useState<{ model: string; value: string; unit: string; page: number | null }>();
  useEffect(() => {
    void fetch("/v1/specs.csv")
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("no specs"))))
      .then((text) => {
        // The published CSV, read far enough to find one battery capacity with a page reference.
        const lines = text.split("\n", 4000);
        const header = (lines[0] ?? "").split(",");
        const at = (name: string) => header.indexOf(name);
        for (const line of lines.slice(1)) {
          const cells = line.split(",");
          if (cells[at("unit")] !== "Ah" || cells[at("tier")] !== "reviewed" || !cells[at("page")]) continue;
          setFigure({ model: cells[at("model_id")] ?? "", value: cells[at("value")] ?? "", unit: "Ah", page: Number(cells[at("page")]) });
          return;
        }
      })
      .catch(() => undefined);
  }, []);

  return (
    <a className="record-card" href="#evidence" aria-label="Inspect a capacity and its source">
      <span className="record-top">
        <img src={`${A}/logos/plate-89-blue.svg`} alt="" width="34" height="19" />
        <span>EQUIPMENT / BATTERY</span>
        <span className="record-arrow">↗</span>
      </span>
      <span className="record-name">{figure?.model ?? "Rolls S48-100LFP"}</span>
      <span className="record-fact">
        <span>Capacity</span>
        <strong>{figure?.value ?? "100"} <small>{figure?.unit ?? "Ah"}</small></strong>
      </span>
      <span className="record-bottom">
        <span className="source-mini">↳ Source{figure?.page ? ` · page ${figure.page}` : ""}</span>
        <span className="evidence amber">Extracted</span>
      </span>
    </a>
  );
}
