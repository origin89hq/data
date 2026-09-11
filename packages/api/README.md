# @origin89/equipment-api

The contract of the read-only `EquipmentApi` the offgrid-equipment Worker exports, and the one
model key rule the dataset resolves names with. Types and zod schemas only; the implementation
is `apps/worker/src/equipment-api.ts`, the store behind it is loaded per release (#83).

A consumer Worker in the same Cloudflare account binds the entrypoint:

```jsonc
"services": [{ "binding": "EQUIPMENT", "service": "offgrid-equipment", "entrypoint": "EquipmentApi" }]
```

and takes one release for one turn:

```ts
const release = await env.EQUIPMENT.release(); // or release(pinnedId) for an evaluation
const found = await release.resolve({ brand: "Victron", model: "SmartSolar MPPT 150/35" });
```

Pin this package from git rather than copying its types, so a contract change is a version change
on the consumer's side. The package is raw TypeScript with no build step, like the rest of this
repository, so a consumer bundled by wrangler or vite reads it as is.
