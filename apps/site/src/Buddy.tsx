import scout from "@origin89/brand/art/buddy-equipment-scout-transparent.webp";
import { Icon } from "./icons.tsx";

export function Buddy() {
  return (
    <section id="buddy" className="section wrap" aria-labelledby="buddy-title">
      <div className="buddy-feature">
        <div className="buddy-art">
          <img
            src={scout}
            alt="Buddy holding blue binoculars, ready to help explore the equipment"
            width="1280"
            height="1280"
            loading="lazy"
          />
          <span className="buddy-sign">BUDDY / YOUR EQUIPMENT GUIDE</span>
        </div>
        <div className="buddy-story">
          <p className="eyebrow">A LITTLE HELP FROM BUDDY</p>
          <h2 id="buddy-title">
            You don’t need to know <br />
            where to look.
          </h2>
          <p>
            Start with what you’re looking for. Buddy can help you find a model, understand a
            specification, and get back to the source.
          </p>
          <div className="buddy-feature-foot">
            <a
              className="button primary"
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
