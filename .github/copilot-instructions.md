# Copilot reviews

Follow `Code Review Rules` in root `AGENTS.md` and the data rules in
`CONTRIBUTING.md`. Prioritize source provenance, schema compatibility, control
authorization, bounded requests, and failures that could silently lose records.

Use the shared `origin89-review` skill if it is already available. Its detailed
criteria are maintained in
[engineering](https://github.com/origin89hq/engineering/blob/main/skills/origin89-review/SKILL.md).
Otherwise, apply the local rules and disclose the missing shared context. Do not
assume the developer's ignored cache exists in the hosted review or run the local
skills refresh there.

Check callers and existing guards before reporting a defect. Give the trigger,
consequence, and precise location; do not repeat an existing finding without new
evidence. Report which checks ran and which evidence is missing. Leave formatting
and metadata to CI. Keep each comment paragraph on one physical line. Review
does not authorize code changes, deployments, publication, or crawler operation.
