# AGENTS.md

## Project: pi-vibe-guard

Pi extension that scores each prompt with the Jev classifier and warns before sending when it reads as loose-spec vibe coding. The user can send anyway or return the prompt to the editor to tighten it.

## Selected modules

- Git
- npm
- .nvmrc
- Environment
- Prettier (`.prettierrc` only — for editor integration, not a declared dep)
- EditorConfig
- README
- AGENTS

ESLint and TypeScript configs were removed: no lint script or build step
used them, and the project has zero dependencies by design. `src/*.ts`
files run through Node's native type stripping, not `tsc`.

## Conventions

Keep changes focused, documented, and consistent with the project's existing patterns.

The deliverable is two files. `.pi/extensions/vibe-guard.ts` is the pi
wiring: it hooks the `input` event and calls into `src/scoring.ts`, which
holds the pure logic (blend formula, regex pattern banks, follow-up
detection, tally math, color bands, suggestions). Keep that split — the
pure module is unit-tested with `node --test` in ~80 ms, while anything
requiring `pi -e` costs seconds per run.

There is no shell command and no standalone script — codemode is a tool
the model calls, not a CLI runner. `scripts/smoke.sh` is the only thing
that boots pi, and it checks wiring only.

It has two scoring engines. Jev (when `TYPESAFE_API_KEY` is set) reads
intent; the local heuristic is a pure-regex fallback with no credentials.
`VIBE_GUARD_ENGINE=auto` picks between them and falls back on Jev failure.
Keep the heuristic's pattern lists aligned with the Jev rubric in
`QUESTIONS` — they are two expressions of the same judgement.

The rubric text in the extension's `QUESTIONS` const is the spec. Don't
add SPEC.md/plan.md/todo.md unless this becomes a multi-module project.
