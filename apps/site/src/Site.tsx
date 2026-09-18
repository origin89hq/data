import avatar from "@origin89/brand/art/avatar-round.webp";
import favicon from "@origin89/brand/icons/favicon.svg";
import mark from "@origin89/brand/logos/plate-89-white.svg";
import { useEffect, useState } from "react";
import { count, fetchIndex, type Index } from "./api.ts";
import { Buddy } from "./Buddy.tsx";
import { Build } from "./build.tsx";
import { SiteFooter, SiteHeader } from "./Chrome.tsx";
import { DataLoading, DataProblem, Skeleton } from "./DataState.tsx";
import { Explorer } from "./explorer.tsx";
import { HERO_QUERY, heroFigure } from "./hero.ts";
import { Icon } from "./icons.tsx";
import { Coverage, Evidence } from "./panels.tsx";
import { type State, useDuckDb } from "./useDuckDb.ts";
import { useQuery } from "./useQuery.ts";

/** The public dataset, with counts and records from the published release. */
export function Site() {
  const [index, setIndex] = useState<Index>();
  const [indexError, setIndexError] = useState(false);
  const [indexAttempt, setIndexAttempt] = useState(0);
  const engine = useDuckDb(index);
  const retryIndex = () => {
    setIndexError(false);
    setIndexAttempt((value) => value + 1);
  };
  const db: State = indexError
    ? { ready: false, error: "The dataset index couldn’t be loaded.", retry: retryIndex }
    : engine;
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately restarts this read after failure.
  useEffect(() => {
    let stale = false;
    void fetchIndex()
      .then((value) => {
        if (!stale) setIndex(value);
      })
      .catch(() => {
        if (!stale) setIndexError(true);
      });
    return () => {
      stale = true;
    };
  }, [indexAttempt]);

  const rows = (table: string) => {
    const total = index?.files[`${table}.parquet`]?.rows;
    return total === undefined ? "—" : count(total);
  };
  const dialects = index?.counts?.dialects;
  // A count that has not arrived is shown as absent, never as zero.
  const pending = !index && !indexError;
  const figure = (value: string) => (pending ? <Skeleton width="72%" /> : value);

  return (
    <>
      <link rel="icon" type="image/svg+xml" href={favicon} />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-field" aria-hidden="true" />
          <div className="hero-copy">
            <div className="o89-wrap hero-grid">
              <div className="hero-main">
                <p className="eyebrow">Open equipment data / by Origin89</p>
                <h1 id="hero-title">
                  A clearer picture
                  <br />
                  <span>of off-grid equipment.</span>
                </h1>
                <p className="lede">
                  Solar from one brand, batteries from another — with every figure traced back to
                  the document it was read from.
                </p>
                <div className="hero-actions">
                  <a className="o89-plate o89-plate-action" href="#explore">
                    Explore the dataset <Icon name="arrowUpRight" />
                  </a>
                  <a className="o89-text-link" href="#build">
                    Build with the data <Icon name="arrowRight" />
                  </a>
                </div>
              </div>
              <div className="hero-side">
                <dl className="hero-counts" aria-busy={pending}>
                  {[
                    [rows("models"), "Equipment models"],
                    [rows("specs"), "Specification rows"],
                    [dialects === undefined ? "—" : count(dialects), "Protocol dialects"],
                    [rows("sources"), "Source records"],
                  ].map(([value, label]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{figure(String(value))}</dd>
                    </div>
                  ))}
                </dl>
                <p className="hero-note">
                  {indexError
                    ? "Dataset counts unavailable"
                    : pending
                      ? "Reading the published index…"
                      : "Live from the published index"}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="section statement">
          <div className="o89-wrap">
            <h2>
              <span>Different equipment.</span>
              <span>Common ground.</span>
            </h2>
            <p className="lede">
              Register maps to rated figures, panels to battery banks. The details that belong
              together, in one place, with their sources attached.
            </p>
            <div className="bus-line">
              <div>
                <b>MIT</b>
                <span>Licensed for any use</span>
              </div>
              <div>
                <b>No key</b>
                <span>Public endpoints, no sign-up</span>
              </div>
              <div>
                <b>Parquet</b>
                <span>Also CSV and JSON</span>
              </div>
              <div>
                <b>Daily</b>
                <span>Published from this repository</span>
              </div>
            </div>
            <p className="field-note">
              One connected dataset, many ways in · published at data.origin89.com
            </p>
          </div>
        </section>

        <section id="dataset" className="section">
          <div className="o89-wrap">
            <div className="center-head">
              <p className="eyebrow">01 / The dataset</p>
              <h2 className="h-l">From the maker’s document to your next idea.</h2>
              <p className="lede">
                Datasheets, protocol references and public equipment libraries become one record per
                model — with the figures, the dialects and the page each came from.
              </p>
            </div>

            <figure
              className="data-flow"
              aria-label="Manufacturer documents and protocol references connect to equipment records, delivered as open data."
            >
              <div className="flow-caption left-caption">From the source</div>
              <div className="flow-caption right-caption">Into your next idea</div>
              <svg
                className="flow-lines"
                viewBox="0 0 1120 268"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {/* User space, not the default object bounding box: the straight connectors are
                    horizontal, so their bounding box has no height and a proportional gradient
                    would be ignored, leaving those two paths unpainted. The coordinates span each
                    group, so every path in it shares one fade. */}
                <defs>
                  <linearGradient id="line-in" gradientUnits="userSpaceOnUse" x1="200" x2="390">
                    <stop stopColor="currentColor" stopOpacity="0.15" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0.9" />
                  </linearGradient>
                  <linearGradient id="line-out" gradientUnits="userSpaceOnUse" x1="730" x2="920">
                    <stop stopColor="currentColor" stopOpacity="0.9" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0.15" />
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
                <g fill="currentColor">
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
            </figure>

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
                      <strong>{figure(String(value))}</strong> {label}
                    </span>
                    <Icon name="arrowRight" />
                  </span>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section id="explore" className="section">
          <div className="o89-wrap">
            <div className="device-head">
              <div>
                <p className="eyebrow">02 / Get to know the data</p>
                <h2 className="h-l">Find the equipment.</h2>
              </div>
              <p className="lede">
                Start with a model, inspect a figure, and follow the evidence back to its document.
              </p>
            </div>
            <Explorer index={index} tier="records" db={db} />
            <p className="field-note">
              <span className="little-dot" /> Select a row to inspect the record and its sources.
            </p>
          </div>
        </section>

        <Evidence db={db} />
        <Coverage db={db} />
        <Buddy />
        <Build index={index} />
      </main>

      <SiteFooter />
    </>
  );
}

/**
 * The card at the centre of the flow: a real figure, fetched, with its page reference. It leads
 * with the figure that describes the model's kind, under its maker's mark.
 */
function HeroRecord({ db }: { db: State }) {
  const result = useQuery(db, HERO_QUERY);
  const figure = heroFigure(result.status === "ready" ? result.data[0]?.rows[0] : undefined);
  const identity = figure?.logo ? (
    <img
      className="record-logo"
      src={figure.logo}
      alt={figure.maker ?? ""}
      width="24"
      height="24"
    />
  ) : (
    <img src={mark} alt="" width="34" height="19" />
  );
  const kind = figure ? `Equipment / ${figure.kind}` : "Equipment";

  if (result.status === "error") {
    return (
      <div className="record-card">
        <span className="record-top">
          {identity}
          <span>{kind}</span>
        </span>
        <DataProblem label="The source example couldn’t be loaded." retry={result.retry} />
      </div>
    );
  }

  return (
    <a
      className="record-card"
      href="#evidence"
      aria-label={
        figure
          ? `Inspect the ${figure.label.toLowerCase()} of ${figure.model} and its source`
          : "Inspect a sourced figure"
      }
    >
      <span className="record-top">
        {identity}
        <span>{kind}</span>
        <Icon name="arrowUpRight" className="record-arrow" />
      </span>
      {result.status === "loading" ? (
        <DataLoading label="Finding a sourced figure…">
          <Skeleton width="85%" />
          <Skeleton width="60%" />
          <Skeleton width="74%" />
        </DataLoading>
      ) : !figure ? (
        <span className="record-name">No sourced example in this release</span>
      ) : (
        <>
          <span className="record-name">{figure.model}</span>
          <span className="record-fact">
            <span>
              {figure.label}
              {figure.condition ? ` · ${figure.condition}` : ""}
            </span>
            <strong>
              {figure.value} <small>{figure.unit}</small>
            </strong>
          </span>
          <span className="record-bottom">
            <span className="source-mini">↳ Source · page {figure.page}</span>
            <span className="evidence amber">{figure.basis}</span>
          </span>
        </>
      )}
    </a>
  );
}
