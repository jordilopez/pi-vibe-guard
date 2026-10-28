# pi-vibe-guard

A Pi extension that scores every prompt with the Jev classifier **before it reaches the model**, and warns you when it reads as loose-spec vibe coding — so you can rephrase first.

```
⚠ Vibe coding detected

This prompt reads as vibe coding (97% · vibe).

• Add a named measurement ("<100ms at n=10k"), an acceptance criterion
  ("all existing tests pass"), or a target path ("edit src/tree.ts").
• You are handing structure to the AI ("you decide"). Pick it yourself,
  or say "recommend one and explain why".

Send anyway?  [y/N]
```

Declining returns the text to the editor so you can tighten it and resend.

## Scoring engines

The guard scores prompts with one of two engines:

| Engine              | When it runs              | Cost                           | Accuracy                       |
| ------------------- | ------------------------- | ------------------------------ | ------------------------------ |
| **Jev**             | `TYPESAFE_API_KEY` is set | one classifier call per prompt | high — reads intent            |
| **Local heuristic** | no key set                | zero — pure regex, in-process  | coarse — reads surface markers |

`auto` (the default) picks Jev when the key is present and the heuristic
otherwise, and **falls back to the heuristic if a Jev call fails**, so the
guard always produces a verdict. Force one with `VIBE_GUARD_ENGINE=jev` or
`VIBE_GUARD_ENGINE=heuristic`.

The heuristic matches the markers the Jev rubric describes — delegation
phrases ("you decide", "whatever you want", "idc"), imperative openings
("fix", "refactor", "make it"), and concrete anchors (numbers with units,
file paths, "must …", "all existing tests pass"). It is deliberately the
fallback, not the default when credentials exist: on the sample prompts it
agrees with Jev roughly half the time, and misses intent-level signals such
as implicit AI hand-off.

## Cumulative session tally

In addition to per-prompt warnings, the extension keeps a running tally per workspace and shows a colored status row in the footer so you can see at a glance how vibe-coded this session has been:

```
● vibe 67% · 3 scored · 1 high      ← yellow
● vibe 96% · 1 scored · 1 high      ← red
● vibe 31% · 5 scored · 1 high      ← green
```

Color thresholds match `VIBE_GUARD_THRESHOLD` exactly:

| Mean vibeP | Color     |
| ---------: | --------- |
|      < 0.5 | 🟢 green  |
|    0.5–0.8 | 🟡 yellow |
|      ≥ 0.8 | 🔴 red    |

The tally resets on `/new` (or opening a fresh session via trust/fork). Slash commands, mid-session follow-ups ("yes"), and extension-injected messages are skipped from the count since they don't get scored.

## Install

The extension lives at `.pi/extensions/vibe-guard.ts`, so it loads automatically when the project is trusted. To try it in one session without trusting the project:

```bash
pi -e ./.pi/extensions/vibe-guard.ts
```

Requires no credentials for the local heuristic engine; set `TYPESAFE_API_KEY` to enable the Jev engine.

## Scoring engines

The guard scores each prompt with one of two engines:

| Engine              | When it runs              | Cost                       | Accuracy                       |
| ------------------- | ------------------------- | -------------------------- | ------------------------------ |
| **Jev**             | `TYPESAFE_API_KEY` is set | one classifier call/prompt | high — reads intent            |
| **Local heuristic** | no key set                | zero — pure regex, in-proc | coarse — reads surface markers |

`auto` (the default) picks Jev when the key is present and the heuristic
otherwise, and **falls back to the heuristic if a Jev call fails**, so the
guard always produces a verdict. Force one with `VIBE_GUARD_ENGINE=jev` or
`VIBE_GUARD_ENGINE=heuristic`.

The heuristic matches the markers the Jev rubric describes — delegation
phrases ("you decide", "whatever you want", "idc"), imperative openings
("fix", "refactor", "make it"), and concrete anchors (numbers with units,
file paths, "must …", "all existing tests pass"). It is deliberately the
fallback rather than the default when credentials exist: on sample prompts
it agrees with Jev roughly half the time, and misses intent-level signals
such as implicit AI hand-off.

## How it works

Pi fires an `input` event on raw user input, before agent processing. The extension hooks it, scores the prompt, and decides:

| Question       | Type                                                   | What it captures                                     |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `concreteness` | 4-way choice (`concrete` / `mostly` / `soft` / `vibe`) | How measured-out the spec is                         |
| `aiHandoff`    | bool                                                   | Is this directed at an AI?                           |
| `delegating`   | bool                                                   | Is this asking AI to pick structure / deps / naming? |

The score is a bounded weighted blend — soft (2) and vibe (3) are **not** lumped together, or a constrained-but-loose prompt would tie a fully vibe-coded one:

```
E[c]  = (0·P(concrete) + 1·P(mostly) + 2·P(soft) + 3·P(vibe)) / 3
vibeP = 0.6 · E[c] + 0.4 · (P(aiHandoff) + P(delegating)) / 2
```

A prompt warns when `vibeP >= THRESHOLD`. Slash commands, empty input, and
known conversational follow-ups ("ok", "yes go on", "sounds good",
"continue") are skipped from both the warning and the tally. **Length is not
a skip signal** — a short imperative like "do whatever" is still scored,
because that is exactly the kind of prompt worth catching.

## Configuration

| Env var                | Default | Effect                                                              |
| ---------------------- | ------- | ------------------------------------------------------------------- |
| `VIBE_GUARD_THRESHOLD` | `0.8`   | Minimum `vibeP` to warn, and the yellow→red boundary                |
| `VIBE_GUARD_ENGINE`    | `auto`  | `auto` \| `jev` \| `heuristic` (see above)                          |
| `VIBE_GUARD_OFF`       | —       | Set to disable the guard without unloading                          |
| `VIBE_GUARD_DEBUG`     | —       | Log per-prompt and session-tally to stderr (used by the smoke test) |

## Project layout

```
src/scoring.ts              pure scoring logic — no pi imports, no network
tests/scoring.test.ts       unit tests for the above (node --test)
.pi/extensions/vibe-guard.ts  pi wiring: input event → score → warn/status
scripts/smoke.sh            one integration check that the wiring loads
```

The split exists so the scoring math is testable without booting pi: the
unit suite runs in ~80 ms, while each `pi -e` invocation costs seconds.
When adding behavior, put the logic in `src/scoring.ts` and test it there;
touch the extension only for pi-specific wiring.

## Development

```bash
npm test         # unit tests — scoring logic, ~80 ms
npm run smoke    # integration — extension loads and scores, ~4 s
npm run check    # both
npm run format   # prettier
```

## Notes

- With Jev enabled the guard adds one classifier round-trip to every prompt it scores. The local heuristic is in-process and free. Set `VIBE_GUARD_OFF=1` when even that isn't worth it.
- Print and JSON modes have no dialog UI, so there the extension only warns (via `notify`) and lets the prompt through.
