# Origin89 Data — design draft

An editable, responsive concept for **data.origin89.com**, based on the equipment dataset in this repository. Open `index.html` directly, or serve this folder:

```sh
python3 -m http.server 4178 --bind 127.0.0.1
```

Then visit <http://127.0.0.1:4178>.

## Direction

[Reelgood Data](https://data.reelgood.com/) informs the presentation structure: dataset scale, clear offerings, and examples that let visitors inspect the value of the data. Visual identity and voice come from [Origin89's live website](https://origin89.com/) and the [design guide distributed with brand-v0.2.0](https://github.com/origin89hq/brand/releases/download/brand-v0.2.0/origin89-design-guide.pdf).

The page uses the live website's warm journal theme: paper `#f5f1e8`, forest ink `#27372d`, muted text `#647366`, rules `#c9cec1`, and quiet field surfaces `#e3e6db`. These values are extracted from the website's actual `journal.css`, not approximated. Bridge blue `#2b4a97`, state colours, and identity assets come from the brand package. The journal theme is the live site's contextual expression; the kit's four core swatches are Bridge blue `#2b4a97`, ink `#07090c`, chalk `#e7eaee`, and paper `#f4f3ef`.

The released guide informed the horizontal light-surface logo, at least 170 px wide in navigation; its unchanged geometry and clear space; Inter Tight for sentence-case copy; IBM Plex Mono for readings and IDs; and Buddy as a still, contextual helper. It is the PDF attached to package release v0.2.0, internally titled Design guide v1.0 / 08 Sep 2026. A familiar, lighter editorial layout and direct useful language connect this page to the rest of origin89.com.

The main route moves from the dataset's purpose into four data offerings, an interactive explorer, a source trail, protocol coverage, Buddy's guidance, and developer integration. The primary action is **Explore the dataset**. **Build with the data** leads to existing file endpoints and code examples. Buddy offers a third route for people who do not know what to search for.

## What works in the draft

- Search, equipment / specification / protocol tabs, category filters, pagination, and filtered sample CSV export.
- Record dialogs with actual values, source links, page references where recorded, and evidence status.
- Coverage chart switching between all entries and entries citing vendor documentation; both use the same linear scale.
- Buddy's three explicitly labelled guided examples: batteries, a specification source, and VE.Direct. They lead to matching explorer or record states. The existing live Buddy is linked separately.
- DuckDB, Python, and cURL snippets, clipboard copy, published download links, and a local manifest viewer.
- Mobile menu, responsive layouts, keyboard tab navigation, slash-to-search, native modal focus handling, and reduced-motion support.

There is no model inference, live SQL execution, authentication, or server-side integration in this draft. The explorer is an illustrative subset of the local release, not the full live dataset. Nothing is deployed.

## Data and identity provenance

All hero counts and coverage totals are taken from the local `dist/` release inspected on **10 September 2026**: 30,360 models, 243,720 specification rows, 288 dialects, 1,280 sources, and 86 manufacturers. The explorer includes 38 models, 49 specification rows, and 24 dialects selected from that release. Counts describe the snapshot, not the current deployed state.

No confidence or product classification was invented. In particular, `tier = reviewed` does **not** become a human-review badge: `reviewed_by` must actually name someone. Missing types remain **Unclassified**. Extracted figures and public-feed figures retain distinct labels. The featured 100 Ah capacity is an extracted Rolls S48-100LFP row citing page 19 of the linked manufacturer document, and has no recorded human reviewer.

Brand assets are copied byte-for-byte from **[@origin89/brand](https://github.com/origin89hq/brand) 0.2.0**: the horizontal wordmark, Plate 89, colour tokens, Inter Tight, IBM Plex Mono, Buddy avatar, and the full-body Buddy studio render. The feature illustration uses contain sizing so the antlers and feet remain visible on desktop and mobile. `provenance.json` records their SHA-256 hashes, source dataset manifest hash, website theme source hash, and the released PDF's hash. Font notices and brand terms travel with the assets. The manufacturer names in the page are typographic references, not copied logo artwork.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Semantic page and dialog structure |
| `styles.css` | Responsive visual design, mapped to the supplied brand tokens |
| `website-tokens.css` | Exact journal theme extracted from the Origin89 website |
| `website.css` | Light website presentation, typography, and kit-aligned identity sizing |
| `app.js` | Local interactions and source/evidence presentation |
| `data.js` | Reproducible local dataset sample and aggregate counts |
| `build_snapshot.py` | Regenerate sample and copy identity assets without changing records |
| `provenance.json` | Brand asset hashes and dataset manifest hash |
| `assets/` | Unmodified brand assets and notices |

To regenerate after installing the project's brand dependency:

```sh
python3 build_snapshot.py /path/to/offgrid-equipment
# Or provide the installed brand package directory explicitly:
python3 build_snapshot.py /path/to/offgrid-equipment /path/to/@origin89/brand
# If the Origin89 website is not in a sibling `origin89` directory:
python3 build_snapshot.py /path/to/offgrid-equipment /path/to/@origin89/brand /path/to/origin89
```

The narrative's fixed example and date should be reviewed if the dataset changes. In a production implementation, all displayed totals should be populated from the published index, and the explorer should query the complete tables. Reuse the existing public Worker routes and DuckDB integration. Only connect Buddy to the dataset once its tool responses preserve source links, conditions, and review status.

## Validation

Checked in the Codex browser at 1280 px desktop, 768 px tablet, and 390 / 320 px mobile widths. No page-level horizontal overflow or missing images were found. The table and code blocks intentionally allow internal scrolling on small screens. Search, no-results state, filtering, tabs, pagination, source dialogs, Buddy handoffs, chart filters, and snippet copy were exercised. JavaScript syntax, local references, and unmodified brand asset hashes were checked separately.

The original Worker page and deployment configuration are outside this draft and are not changed by it.
