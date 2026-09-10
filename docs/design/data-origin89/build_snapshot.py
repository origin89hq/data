"""Build the design's small, explicitly labelled sample from the local release.

Usage: python3 build_snapshot.py /path/to/offgrid-equipment [path/to/brand-package] [path/to/origin89]
No network, no record mutations. Brand files are copied without modification.
"""
import collections
import csv
import hashlib
import json
import re
from pathlib import Path
import shutil
import sys

project = Path(sys.argv[1]).resolve()
out = Path(__file__).resolve().parent
dist = project / 'dist'
def table(name):
    with (dist / f'{name}.csv').open() as f:
        return list(csv.DictReader(f))

manifest = json.loads((dist / 'manifest.json').read_text())
models = table('models')
specs = table('specs')
makers = {r['id']: r for r in table('manufacturers')}
sources = {r['id']: r for r in table('sources')}
dialects = table('dialects')
by_model = collections.defaultdict(list)
for s in specs:
    by_model[s['model_id']].append(s)

preferred = ['rolls-battery-s48-100lfp', 'eg4-electronics-6000xp',
             'victron-energy-smartsolar-mppt-100-50', 'eg4-electronics-12kpv',
             'rolls-battery-s-550', 'eg4-electronics-chargeverter-gc']
selected = [next(m for m in models if m['id'] == key) for key in preferred]
for kind in ['battery', 'inverter', 'inverter-charger', 'charge-controller',
             'panel', 'generator', 'bms', 'shunt-monitor']:
    candidates = [m for m in models if m['kind'] == kind and m not in selected]
    candidates.sort(key=lambda m: (not bool(by_model[m['id']]), len(m['name']) < 5, m['id']))
    seen = set()
    for m in candidates:
        owner = m['manufacturer_id'] or m['manufacturer_name']
        if owner in seen:
            continue
        selected.append(m)
        seen.add(owner)
        if len(seen) == 4:
            break

def spec_row(s):
    return {**s, 'source': sources.get(s['source_id'], {})}

for m in selected:
    m['maker'] = makers.get(m['manufacturer_id'], {}).get('name') or m['manufacturer_name'] or m['manufacturer_id']
    available = sorted(by_model[m['id']], key=lambda s: (bool(s['doubt']), not bool(s['unit']), not bool(s['page']), s['name']))
    m['spec_count'] = len(available)
    m['specs'] = [spec_row(s) for s in available[:8]]

hero = next(s for s in specs if s['model_id'] == 'rolls-battery-s48-100lfp' and s['name'] == 'Capacity')
selected_specs = [spec_row(hero)]
for m in selected:
    selected_specs += [s for s in m['specs'][:2] if s['id'] != hero['id']]

links = collections.defaultdict(list)
for row in table('dialect_sources'):
    links[row['dialect_id']].append(sources.get(row['source_id'], {}))
sample_dialects = []
for family in dict.fromkeys(d['family'] for d in dialects):
    candidates = [d for d in dialects if d['family'] == family]
    # Show evidence variety instead of letting alphabetic IDs make every
    # VE.Direct example an unverified entry.
    examples = []
    for status in ['vendor-doc', 'community-crosschecked', 'community-single', 'unverified']:
        found = next((d for d in candidates if d['confidence'] == status), None)
        if found:
            examples.append(found)
    examples = examples[:2] + [next((d for d in candidates if d['confidence'] == 'unverified'), candidates[-1])]
    examples = list({d['id']: d for d in examples}.values())
    examples += [d for d in candidates if d not in examples][:3-len(examples)]
    for d in examples:
        sample_dialects.append({**d, 'sources': links[d['id']]})

front_page = ['rolls-battery-s48-100lfp', 'luxpower-lxp-lb-us-12k',
              'morningstar-ps-15', 'sam-cec-abb-pvi-30-outd-s-us-a-208v',
              'rolls-battery-s48-100lfp-stack-lv', 'victron-energy-smartsolar-mppt-100-50']
selected.sort(key=lambda m: front_page.index(m['id']) if m['id'] in front_page else len(front_page))
families = collections.Counter(d['family'] for d in dialects)
data = {
    'snapshot': '2026-09-10',
    'counts': {k.removesuffix('.parquet'): v['rows'] for k, v in manifest['files'].items() if k.endswith('.parquet')},
    'manifest': manifest,
    'kinds': dict(collections.Counter(m['kind'] or 'unclassified' for m in models)),
    'confidence': dict(collections.Counter(d['confidence'] for d in dialects)),
    'families': [{'id': k, 'count': n, 'documented': sum(d['family'] == k and d['confidence'] == 'vendor-doc' for d in dialects)} for k, n in families.most_common()],
    'models': selected, 'specs': selected_specs, 'dialects': sample_dialects,
    'hero': spec_row(hero),
    'specTiers': dict(collections.Counter(s['tier'] for s in specs)),
    'extractedCount': sum(bool(s['extracted_by']) for s in specs),
    'humanReviewedCount': sum(bool(s['reviewed_by']) for s in specs),
}
(out / 'data.js').write_text('window.ORIGIN89_DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + ';\n')
brand = Path(sys.argv[2]) if len(sys.argv) > 2 else project / 'worker/node_modules/@origin89/brand'
assets = ['tokens/themes.css', 'logos/origin89-horizontal-white.svg', 'logos/origin89-horizontal-blue.svg',
          'logos/plate-89-blue.svg', 'art/avatar-round.webp',
          'art/studio-transparent.webp', 'fonts/InterTight-Variable.ttf',
          'fonts/IBMPlexMono-Regular.ttf', 'fonts/InterTight-OFL.txt',
          'fonts/IBMPlexMono-OFL.txt', 'LICENSE.md']
provenance = {'brandPackage': '@origin89/brand', 'version': json.loads((brand / 'package.json').read_text())['version'], 'files': {}}
previous_provenance = out / 'provenance.json'
if previous_provenance.exists():
    previous = json.loads(previous_provenance.read_text())
    if 'designGuide' in previous:
        provenance['designGuide'] = previous['designGuide']
for name in assets:
    dest = out / 'assets' / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(brand / name, dest)
    provenance['files'][name] = hashlib.sha256(dest.read_bytes()).hexdigest()
provenance['datasetManifestSha256'] = hashlib.sha256((dist / 'manifest.json').read_bytes()).hexdigest()
website = Path(sys.argv[3]) if len(sys.argv) > 3 else project.parent / 'origin89'
theme_source = website / 'apps/website/src/react/styles/journal.css'
if theme_source.is_file():
    block = re.search(r'\.web-journal\s*\{([^}]+)\}', theme_source.read_text()).group(1)
    properties = dict(re.findall(r'(--journal-[a-z-]+):\s*([^;]+);', block))
    (out / 'website-tokens.css').write_text('/* Snapshot of the live website\'s cottage theme. Source: apps/website/src/react/styles/journal.css */\n:root {\n' + ''.join(f'  {k}: {v};\n' for k,v in properties.items()) + '}\n')
    provenance['websiteTheme'] = {'source': 'origin89/apps/website/src/react/styles/journal.css', 'sha256': hashlib.sha256(theme_source.read_bytes()).hexdigest(), 'properties': properties}
else:
    raise SystemExit('Pass the Origin89 website repository as the fourth argument to preserve its exact theme.')
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
print(f'Built {len(selected)} model examples, {len(selected_specs)} specification examples, {len(sample_dialects)} dialect examples; brand {provenance["version"]}.')
