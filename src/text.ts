/**
 * Undo a run of UTF-8 bytes that were read as Latin-1.
 *
 * A Unique Appliances sheet came back naming a preset temperature "Temp\u00e9rature pr\u00e9d\u00e9finie
 * \u00e2\u0080\u0093 Comf": the accented e survived, but the en dash did not. Its three UTF-8 bytes
 * arrived as three separate characters. Only runs that are valid UTF-8 when treated as bytes are
 * touched, which is why the accented e is left alone: on its own it is not a sequence, so there is
 * nothing to decode and nothing is guessed.
 */
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A UTF-8 lead byte and its continuations, as the characters a mis-decode leaves behind. */
const RUN = /[\u00c2-\u00f4][\u0080-\u00bf]{1,3}/g;

/** The text with any such run decoded, and every other character untouched. */
export function repairMojibake(text: string): string {
  return text.replace(RUN, (run) => {
    const bytes = Uint8Array.from([...run].map((character) => character.codePointAt(0) ?? 0));
    try {
      return decoder.decode(bytes);
    } catch {
      return run;
    }
  });
}
