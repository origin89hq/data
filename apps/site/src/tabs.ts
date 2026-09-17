import type { KeyboardEvent } from "react";

/**
 * Roving focus for a tablist, which the ARIA tabs pattern requires and a plain set of buttons does
 * not give you: only the selected tab sits in the tab order, so without the arrow keys a keyboard
 * reaches the first tab and can never get to the others.
 */
export function tablistKeys<T extends string>(
  names: readonly T[],
  current: T,
  select: (name: T) => void,
) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const at = names.indexOf(current);
    const last = names.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % names.length
        : event.key === "ArrowLeft"
          ? (at + last) % names.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    const name = next < 0 ? undefined : names[next];
    if (name === undefined) return;
    event.preventDefault();
    select(name);
    // Selection alone would leave focus on the tab the reader just left.
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
}
