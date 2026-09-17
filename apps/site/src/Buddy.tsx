import scout from "@origin89/brand/art/buddy-equipment-scout-transparent.webp";
import { Icon } from "./icons.tsx";

export function Buddy() {
  return (
    <section id="buddy" className="section" aria-labelledby="buddy-title">
      <div className="o89-wrap buddy-feature">
        <figure className="buddy-art">
          <img
            src={scout}
            alt="Buddy holding blue binoculars, ready to help explore the equipment"
            width="1280"
            height="1280"
            loading="lazy"
          />
          <figcaption className="eyebrow">Buddy / your equipment guide</figcaption>
        </figure>
        <div className="buddy-story">
          <p className="eyebrow">A little help from Buddy</p>
          <h2 id="buddy-title" className="h-l">
            You don’t need to know where to look.
          </h2>
          <p className="lede">
            Start with what you’re looking for. Buddy can help you find a model, understand a
            specification, and get back to the source.
          </p>
          <div className="buddy-feature-foot">
            <a
              className="o89-plate o89-plate-action"
              href="https://origin89.com/buddy/"
              target="_blank"
              rel="noopener"
            >
              Find it with Buddy <Icon name="arrowUpRight" />
            </a>
            <span>On Origin89</span>
          </div>
        </div>
      </div>
    </section>
  );
}
