import avatar from "@origin89/brand/art/avatar-round.webp";
import favicon from "@origin89/brand/icons/favicon.svg";
import logo from "@origin89/brand/logos/origin89-horizontal-blue.svg";
import mark from "@origin89/brand/logos/plate-89-blue.svg";
import { useEffect, useState } from "react";
import { count, fetchIndex, type Index } from "./api.ts";
import { Buddy } from "./Buddy.tsx";
import { Build } from "./build.tsx";
import { Explorer } from "./explorer.tsx";
import { Icon } from "./icons.tsx";
import { Coverage, Evidence } from "./panels.tsx";
import { type State, useDuckDb } from "./useDuckDb.ts";

/** The public dataset, with counts and records from the published release. */
export function Site() {
  const [index, setIndex] = useState<Index>();
  const [indexError, setIndexError] = useState(false);
  const db = useDuckDb(index);
  useEffect(() => {
    void fetchIndex()
      .then(setIndex)
      .catch(() => setIndexError(true));
  }, []);

  const rows = (table: string) => {
    const total = index?.files[`${table}.parquet`]?.rows;
    return total === undefined ? "—" : count(total);
  };
  const dialects = index?.counts?.dialects;

  return (
    <>
      <link rel="icon" type="image/svg+xml" href={favicon} />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="identity" href="https://origin89.com" aria-label="Origin89 Data home">
          <img src={logo} width="159" height="27" alt="Origin89" />
          <span className="identity-divider" />
          <span className="data-word">data</span>
        </a>
        <nav id="navigation" aria-label="Main navigation">
          <a href="#dataset">The dataset</a>
          <a href="#explore">Explore data</a>
          <a href="#build">For developers</a>
          <a
            className="nav-source"
            href="https://github.com/origin89hq/offgrid-equipment"
            target="_blank"
            rel="noopener"
          >
            GitHub <Icon name="arrowUpRight" />
          </a>
        </nav>
        <a
          className="button small nav-buddy"
          href="https://origin89.com/buddy/"
          target="_blank"
          rel="noopener"
        >
          <img src={avatar} width="22" height="22" alt="" />
          Ask Buddy <Icon name="arrowUpRight" />
        </a>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-intro wrap">
            <p className="eyebrow hero-eyebrow">
              <span className="little-dot" /> OPEN EQUIPMENT DATA / BY ORIGIN89
            </p>
            <h1 id="hero-title">
              A clearer picture
              <br />
              <span>of off-grid equipment.</span>
            </h1>
            <p className="hero-copy">
              Solar from one brand. Batteries from another. The details, together.
              <br className="desktop-break" /> Find models, read the specifications, and follow each
              source.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#explore">
                Explore the dataset <Icon name="arrowUpRight" />
              </a>
              <a className="button quiet" href="#build">
                Build with the data <Icon name="arrowRight" />
              </a>
            </div>
            <div className="open-note">
              <span>MIT licensed</span>
              <span>No API key</span>
              <span>Yours to build on</span>
            </div>
          </div>

          <div
            className="data-flow wrap"
            role="img"
            aria-label="Manufacturer documents and protocol references connect to equipment records, delivered as open data."
          >
            <div className="flow-caption left-caption">FROM THE SOURCE</div>
            <div className="flow-caption right-caption">INTO YOUR NEXT IDEA</div>
            <svg
              className="flow-lines"
              viewBox="0 0 1120 268"
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="line-in">
                  <stop stopColor="#2b343f" />
                  <stop offset="1" stopColor="#6279ad" />
                </linearGradient>
                <linearGradient id="line-out">
                  <stop stopColor="#6279ad" />
                  <stop offset="1" stopColor="#2b343f" />
                </linearGradient>
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
                <circle cx="390" cy="139" r="3" />
                <circle cx="730" cy="139" r="3" />
                <circle cx="269" cy="76" r="2.5" />
                <circle cx="846" cy="204" r="2.5" />
              </g>
            </svg>
            <div className="source-stack">
              <div className="flow-chip">
                <span className="file-icon">PDF</span>
                <span>Manufacturer datasheets</span>
              </div>
              <div className="flow-chip">
                <span className="file-icon">{"{ }"}</span>
                <span>Protocol references</span>
              </div>
              <div className="flow-chip">
                <span className="file-icon">≋</span>
                <span>Public equipment libraries</span>
              </div>
            </div>
            <HeroRecord db={db} />
            <div className="destination-stack">
              <div className="flow-chip">
                <span className="file-icon">
                  <Icon name="download" />
                </span>
                <span>Parquet / CSV / JSON</span>
              </div>
              <div className="flow-chip">
                <span className="file-icon">&gt;_</span>
                <span>Your tools &amp; applications</span>
              </div>
              <div className="flow-chip">
                <img src={avatar} alt="" width="30" height="30" />
                <span>A little help from Buddy</span>
              </div>
            </div>
          </div>

          <div className="stats-wrap wrap">
            <div className="stats">
              {[
                [rows("models"), "Equipment models"],
                [rows("specs"), "Specification rows"],
                [dialects === undefined ? "—" : count(dialects), "Protocol dialects"],
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
              <span>
                PUBLISHED AT <span className="snapshot-date">DATA.ORIGIN89.COM</span>
              </span>
            </div>
          </div>
        </section>

        <section id="dataset" className="section wrap">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / THE DATASET</p>
              <h2>
                Different equipment.
                <br />
                Common ground.
              </h2>
            </div>
            <p>
              Solar panels to battery banks. Register maps to rated figures. The details that belong
              together, finally in one place.
            </p>
          </div>
          <div className="data-pillars">
            {(
              [
                {
                  number: "01",
                  icon: "equipment",
                  title: "Equipment identity",
                  body: "Models, makers, and aliases. A shared identity to connect your equipment records.",
                  value: rows("models"),
                  label: "models",
                  href: "#explore",
                },
                {
                  number: "02",
                  icon: "specifications",
                  title: "Specifications",
                  body: "Rated figures with their units, conditions, and original source. Context stays attached.",
                  value: rows("specs"),
                  label: "rated figures",
                  href: "#explore",
                },
                {
                  number: "03",
                  icon: "protocols",
                  title: "Protocols & dialects",
                  body: "Register maps, frame layouts, and driver status. See what’s documented.",
                  value: dialects === undefined ? "—" : count(dialects),
                  label: "dialects",
                  href: "#explore",
                },
                {
                  number: "04",
                  icon: "evidence",
                  title: "Evidence & confidence",
                  body: "Follow a claim to its reference. See where it came from and what has been checked.",
                  value: rows("sources"),
                  label: "source records",
                  href: "#evidence",
                },
              ] as const
            ).map(({ number, icon, title, body, value, label, href }) => (
              <a key={number} className="pillar" href={href}>
                <span className="pillar-top">
                  <span className="pillar-symbol">
                    <Icon name={icon} />
                  </span>
                  <span className="pillar-number">{number}</span>
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
                <span className="pillar-foot">
                  <span>
                    <strong>{value}</strong> {label}
                  </span>
                  <Icon name="arrowRight" />
                </span>
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
              <p>
                Start with a model. Inspect a figure.
                <br />
                Follow the evidence all the way back.
              </p>
            </div>
            {indexError ? (
              <div className="data-load-error" role="alert">
                <h3>The dataset couldn’t be loaded.</h3>
                <p>Check your connection and reload to try again.</p>
                <button
                  className="button small"
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  Reload the page
                </button>
              </div>
            ) : (
              <Explorer index={index} tier="reviewed" db={db} />
            )}
            <div className="explorer-helper">
              <span>
                <span className="little-dot" /> Every record here is live from the published tables.
                Select a row to inspect it.
              </span>
            </div>
          </div>
        </section>

        <Evidence db={db} />
        <Coverage db={db} />
        <Buddy />
        <Build index={index} />
      </main>

      <footer className="closing wrap">
        <p>
          Built by <a href="https://origin89.com">Origin89</a> ·{" "}
          <a href="https://github.com/origin89hq/offgrid-equipment">source on GitHub</a> ·{" "}
          <a href="mailto:hello@origin89.com">hello@origin89.com</a>
        </p>
        <p>
          Corrections are the most useful contribution. Every figure names its document, so a wrong
          one can be shown wrong.
        </p>
      </footer>
    </>
  );
}

/** The card at the centre of the hero: a real figure, fetched, with its page reference. */
function HeroRecord({ db }: { db: State }) {
  const [figure, setFigure] = useState<{ model: string; value: string; page: string }>();
  useEffect(() => {
    if (!db.ready) return;
    let stale = false;
    void db
      .run(`SELECT model_id, value, page FROM specs
      WHERE unit = 'Ah' AND tier = 'reviewed' AND page IS NOT NULL AND doubt IS NULL
      ORDER BY model_id LIMIT 1`)
      .then(({ rows }) => {
        const row = rows[0];
        if (!stale && row)
          setFigure({
            model: String(row.model_id),
            value: String(row.value),
            page: String(row.page),
          });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [db]);

  return (
    <a className="record-card" href="#evidence" aria-label="Inspect a capacity and its source">
      <span className="record-top">
        <img src={mark} alt="" width="34" height="19" />
        <span>EQUIPMENT / BATTERY</span>
        <Icon name="arrowUpRight" className="record-arrow" />
      </span>
      <span className="record-name">{figure?.model ?? "Equipment & its source"}</span>
      <span className="record-fact">
        <span>Capacity</span>
        <strong>
          {figure?.value ?? "—"} <small>{"Ah"}</small>
        </strong>
      </span>
      <span className="record-bottom">
        <span className="source-mini">↳ Source{figure?.page ? ` · page ${figure.page}` : ""}</span>
        <span className="evidence amber">Extracted</span>
      </span>
    </a>
  );
}
