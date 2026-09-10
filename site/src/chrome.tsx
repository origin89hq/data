import type { ReactNode } from "react";
import wordmark from "@origin89/brand/logos/origin89-horizontal-black.svg";
import { count, rowsOf, type Index } from "./api.ts";

/** The page's measure. One value, so every band lines up down the left edge. */
export const WRAP = "mx-auto w-[calc(100%-104px)] max-w-[1176px]";

/** A small mono label above a heading, which is how this identity introduces a section. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="m-0 font-mono text-[10px] tracking-[0.055em] text-muted uppercase">{children}</p>;
}

/** A band of the page. */
export function Section({ id, eyebrow, title, lede, children }: { id?: string; eyebrow?: string; title?: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <section id={id} className="border-t border-line py-[86px]">
      <div className={WRAP}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        {title && <h2 className="mt-4 max-w-[18ch] text-[clamp(34px,3.6vw,48px)]">{title}</h2>}
        {lede && <p className="mt-5 max-w-[62ch] text-[17px] text-muted">{lede}</p>}
        {children}
      </div>
    </section>
  );
}

/** Square, quiet, and bordered: the journal's button rather than a rounded web one. */
export function Button({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      className={`inline-block border px-[21px] py-4 text-sm transition-colors hover:bg-[var(--journal-field)] ${
        primary ? "border-action" : "border-line"
      }`}
    >
      {children}
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 flex min-h-[114px] flex-wrap items-center justify-between gap-8 border-b border-line bg-page px-6 py-[26px] sm:px-[52px]">
      <a href="https://origin89.com" className="flex items-center gap-[17px]" aria-label="Origin89">
        <img src={wordmark} alt="" className="w-[186px]" />
        <span className="border-l border-line pl-[17px] font-mono text-[16px] text-muted">data</span>
      </a>
      <nav className="flex flex-wrap items-center gap-[30px] text-sm">
        <a href="#explore" className="hover:text-action">Explore</a>
        <a href="#evidence" className="hover:text-action">Evidence</a>
        <a href="#coverage" className="hover:text-action">Coverage</a>
        <a href="#build" className="hover:text-action">Build</a>
        <a href="https://github.com/origin89hq/offgrid-equipment" className="hover:text-action">GitHub</a>
      </nav>
    </header>
  );
}

export function Hero({ index }: { index?: Index }) {
  return (
    <div className="py-[86px]">
      <div className={WRAP}>
        <Eyebrow>Open dataset · MIT</Eyebrow>
        <h1 className="mt-5 max-w-[16ch] text-[clamp(40px,6vw,72px)]">
          A clearer picture
          <br />
          of off-grid equipment.
        </h1>
        <p className="mt-7 max-w-[60ch] text-[18px] text-muted">
          Manufacturers, models, the figures their datasheets state, and the protocols a controller can actually speak
          to them with. Every figure names the document it came from and the page it was read off, so you can disagree
          with it.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Button href="#explore" primary>Explore the dataset</Button>
          <Button href="#build">Build with the data</Button>
        </div>
        <dl className="mt-14 grid grid-cols-2 gap-x-10 gap-y-8 border-t border-line pt-10 sm:grid-cols-4">
          {[
            [rowsOf(index, "specs"), "rated figures"],
            [rowsOf(index, "models"), "models"],
            [index?.counts?.dialects ?? rowsOf(index, "dialects"), "protocols"],
            [rowsOf(index, "sources"), "source documents"],
          ].map(([n, label]) => (
            <div key={String(label)}>
              <dt className="font-mono text-[11px] tracking-[0.055em] text-muted uppercase">{label}</dt>
              <dd className="m-0 mt-2 font-mono text-[clamp(26px,3vw,34px)] tracking-tight">{count(Number(n))}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** What the dataset is made of, said once so the rest of the page can assume it. */
export function Offerings() {
  const offerings = [
    ["Equipment identity", "One record per product, under the name the maker put on the case. A shop's spelling becomes an alias rather than a second product."],
    ["Specifications", "Rated figures in long format, each with the unit the maker printed and the conditions it holds under."],
    ["Protocols and dialects", "What a controller can say to a device and over what, down to the register map where one is documented."],
    ["Evidence and confidence", "Every figure names its document, its page, and whether a model read it or a parser did. A doubtful one says so."],
  ];
  return (
    <Section eyebrow="What is in it" title={<>Different equipment.<br />Common ground.</>}>
      <div className="mt-12 grid gap-px border border-line bg-line sm:grid-cols-2">
        {offerings.map(([title, body]) => (
          <div key={title} className="bg-page p-8">
            <h3 className="text-[19px]">{title}</h3>
            <p className="mt-3 max-w-[46ch] text-[15px] text-muted">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
