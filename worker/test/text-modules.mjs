import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

/**
 * Let Node load a `.css` or `.svg` import as text, the way wrangler does.
 *
 * The page imports the Origin89 palette and the Plate 89 mark straight out of `@origin89/brand`,
 * which is what stops the palette being a copy that drifts. Wrangler is configured to hand those
 * files over as text; Node is not, so without this the whole route module fails to load and the
 * router cannot be tested at all.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (/\.(css|svg)$/.test(specifier)) {
      return { ...next(specifier, context), format: "module", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.(css|svg)$/.test(url)) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }
    return next(url, context);
  },
});
