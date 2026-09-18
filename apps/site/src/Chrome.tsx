import logo from "@origin89/brand/logos/origin89-horizontal-white.svg";
import type { SVGProps } from "react";
import { Icon } from "./icons.tsx";

/** GitHub's mark, kept local so the source links need no third-party asset request. */
export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const REPOSITORY = "https://github.com/origin89hq/offgrid-equipment";

const SECTIONS: readonly (readonly [string, string])[] = [
  ["The dataset", "#dataset"],
  ["Explore data", "#explore"],
  ["Evidence", "#evidence"],
  ["For developers", "#build"],
];

/**
 * The same floating navigation origin89.com carries, qualified by "data": this is one product's
 * dataset, not a separate site. The wordmark links back to the company, the sections link within.
 */
export function SiteHeader() {
  return (
    <header className="o89-nav">
      <a className="o89-nav-logo" href="https://origin89.com" aria-label="Origin89 home">
        <img src={logo} alt="Origin89" width="132" height="22" />
        <span>data</span>
      </a>
      <nav aria-label="Dataset navigation">
        {SECTIONS.map(([label, href]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <a
        className="o89-nav-github"
        href={REPOSITORY}
        target="_blank"
        rel="noopener"
        aria-label="offgrid-equipment on GitHub"
      >
        <GitHubIcon />
      </a>
      <a
        className="o89-plate o89-plate-ghost o89-plate-sm o89-nav-cta"
        href="https://origin89.com/buddy/"
        target="_blank"
        rel="noopener"
      >
        Ask Buddy <Icon name="arrowUpRight" />
      </a>
      <details className="concept-menu">
        <summary>Menu</summary>
        <nav aria-label="Dataset navigation">
          {SECTIONS.map(([label, href]) => (
            <a key={href} href={href}>
              {label} <Icon name="arrowRight" />
            </a>
          ))}
          <a href={REPOSITORY} target="_blank" rel="noopener">
            GitHub <Icon name="arrowUpRight" />
          </a>
        </nav>
      </details>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="o89-footer">
      <div className="o89-wrap o89-footer-grid">
        <div className="o89-footer-brand">
          <a href="https://origin89.com" aria-label="Origin89 home">
            <img src={logo} alt="Origin89" width="168" height="28" />
          </a>
          <p>
            An open dataset of off-grid power equipment: manufacturers, models, rated figures and
            the protocols a controller can speak to them with.
          </p>
          <p className="o89-footer-status">
            <i aria-hidden="true" />
            Published from the tables in this repository.
          </p>
        </div>
        <nav aria-label="Dataset links">
          <b>Dataset</b>
          <a href="#dataset">What it covers</a>
          <a href="#explore">Explore the records</a>
          <a href="#evidence">Evidence and sources</a>
          <a href="/manifest.json">Published index</a>
        </nav>
        <nav aria-label="Developer links">
          <b>Build</b>
          <a href="#build">Query the data</a>
          <a href="/v1/models.parquet">models.parquet</a>
          <a href="/v1/specs.csv">specs.csv</a>
          <a href={REPOSITORY}>Source on GitHub</a>
        </nav>
        <nav aria-label="Origin89 links">
          <b>Origin89</b>
          <a href="https://origin89.com">Website</a>
          <a href="https://origin89.com/buddy/">Buddy</a>
          <a href={`${REPOSITORY}/blob/main/CONTRIBUTING.md`}>Contribute a correction</a>
          <a href="mailto:hello@origin89.com">hello@origin89.com</a>
        </nav>
        <div className="o89-footer-legal">
          <span>MIT licensed · Public feeds retain their own licences</span>
          <span className="prose">
            Every figure names its document, so a wrong one can be shown wrong. Corrections are the
            most useful contribution.
          </span>
        </div>
      </div>
    </footer>
  );
}
