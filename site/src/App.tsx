import { useEffect, useState } from "react";
import { fetchIndex, fetchMakers, type Index, type Maker } from "./api.ts";
import { Console, Makers, Tables } from "./sections.tsx";
import { Hero, Offerings, SiteHeader, WRAP } from "./chrome.tsx";
import { BuddyNote, Coverage, Evidence } from "./evidence.tsx";
import { Licence, Usage } from "./usage.tsx";

/**
 * The whole page. It holds no numbers of its own: the counts, the tables and the makers all come
 * from the endpoints anybody else would call, so what a reader sees is what is published.
 */
export function App() {
  const [index, setIndex] = useState<Index>();
  const [makers, setMakers] = useState<Maker[]>([]);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    void fetchIndex().then(setIndex).catch((error: unknown) => setFailed(String(error)));
    void fetchMakers().then(setMakers).catch(() => setMakers([]));
  }, []);

  return (
    <>
      <SiteHeader />
      <main>
        <Hero index={index} />
      {failed && (
        <div className="mx-auto max-w-5xl px-6 py-6">
          <p className="m-0 border-l-2 border-alarm pl-4 text-muted">
            The index did not answer, so the numbers below are missing rather than wrong: {failed}
          </p>
        </div>
      )}
        <Offerings />
        {makers.length > 0 && <Makers makers={makers} />}
        <Console index={index} />
        <Evidence index={index} />
        <Coverage index={index} />
        <BuddyNote />
        <Tables index={index} />
        <Usage origin={window.location.origin} />
        <Licence />
      </main>
      <footer className="border-t border-line px-6 pt-11 pb-18">
        <div className={`${WRAP} text-[13.5px] text-muted`}>
          <p className="m-0">
            Built by <a className="text-action hover:underline" href="https://origin89.com">Origin89</a> ·{" "}
            <a className="text-action hover:underline" href="https://github.com/origin89hq/offgrid-equipment">source on GitHub</a> ·{" "}
            <a className="text-action hover:underline" href="mailto:hello@origin89.com">hello@origin89.com</a>
          </p>
          <p className="m-0 mt-1.5">
            Corrections are the most useful contribution. Every figure names its document, so a wrong one can be shown wrong.
          </p>
        </div>
      </footer>
    </>
  );
}
