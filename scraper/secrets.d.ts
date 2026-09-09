/**
 * Secrets are not in the Wrangler config, so `wrangler types` cannot know about them and would
 * overwrite anything added to the file it generates. Declaring them here merges into the same
 * `Env` and survives regeneration.
 */
interface Env {
  /**
   * Shared secret every control endpoint requires, set with `wrangler secret put CONTROL_TOKEN`.
   * Optional on purpose: a deployment that has not been given one must refuse every request, and
   * a type that promised it was always present would hide that case rather than force it.
   */
  CONTROL_TOKEN?: string;
}
