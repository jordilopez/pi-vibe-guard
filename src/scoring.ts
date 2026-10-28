// src/scoring.ts — pure scoring logic for vibe-guard.
//
// This module has zero pi-framework imports and zero network calls. It is
// testable in milliseconds with `node --test`, and it is the single source
// of truth for the scoring formula. The extension at
// `.pi/extensions/vibe-guard.ts` only wires it into pi's input event.
//
// Both engines — Jev (networked, intent-aware) and the local heuristic
// (regex-only, surface-aware) — emit the same `Verdict` shape, so callers
// don't have to branch on the source. The math is the same too: a bounded
// weighted blend that keeps soft (2) and vibe (3) on the concreteness scale
// un-lumped, so a constrained-but-loose prompt doesn't tie a fully
// vibe-coded one.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BOOST = 0.4;

const THRESHOLD_FALLBACK = 0.8;
export function threshold(): number {
  return Number(process.env.VIBE_GUARD_THRESHOLD ?? THRESHOLD_FALLBACK);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Probs = Record<string, number>;
export type Concreteness = 'concrete' | 'mostly' | 'soft' | 'vibe';
export type Color = 'green' | 'yellow' | 'red';
export type Engine = 'auto' | 'jev' | 'heuristic';
export type Source = 'jev' | 'heuristic';

export type Verdict = {
  source: Source;
  vibeP: number;
  concreteness: Concreteness;
  probs: Probs;
  aiHandoff: number;
  delegating: number;
};

export type Score = { vibeP: number; isHigh: boolean };
export type Stats = { n: number; mean: number; high: number; color: Color };

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * Weighted expected concreteness, normalized to [0, 1].
 *   E[c] = (0·P(concrete) + 1·P(mostly) + 2·P(soft) + 3·P(vibe)) / 3
 */
export function expectedConcreteness(p: Probs): number {
  const c = p.concrete ?? 0;
  const m = p.mostly ?? 0;
  const s = p.soft ?? 0;
  const v = p.vibe ?? 0;
  return (c * 0 + m * 1 + s * 2 + v * 3) / 3;
}

/**
 * Full vibeP blend (SPEC § Architecture, simplified into the helper since
 * the same shape is reused by both engines).
 *   vibeP = (1 - BOOST) · E[c] + BOOST · (P(aiHandoff) + P(delegating)) / 2
 */
export function scoreBlend(
  probs: Probs,
  aiHandoff: number,
  delegating: number,
): number {
  // Bounded weighted blend — clamp so out-of-range inputs can't escape.
  const e = expectedConcreteness(probs);
  const d = (aiHandoff + delegating) / 2;
  return Math.max(0, Math.min(1, (1 - BOOST) * e + BOOST * d));
}

// ---------------------------------------------------------------------------
// Follow-up detection
// ---------------------------------------------------------------------------

/**
 * Whitelist of conversational words. A prompt is a "follow-up" if every
 * word is in this set and there are ≤ 4 words. Deliberately excludes
 * "do"/"it" so prompts like "do it" and "do whatever" are scored.
 */
export const FOLLOW_UP_WORDS: ReadonlySet<string> = new Set([
  'y',
  'n',
  'yes',
  'no',
  'ok',
  'okay',
  'sure',
  'thanks',
  'thank',
  'you',
  'go',
  'on',
  'ahead',
  'continue',
  'proceed',
  'sounds',
  'sound',
  'good',
  'looks',
  'look',
  'lgtm',
  'please',
  'cheers',
  'great',
  'perfect',
]);
export const FOLLOW_UP_MAX_WORDS = 4;

export function isFollowUp(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > FOLLOW_UP_MAX_WORDS) return false;
  return words.every((word) => FOLLOW_UP_WORDS.has(word));
}

// ---------------------------------------------------------------------------
// Skip predicate (input gating)
// ---------------------------------------------------------------------------

export type SkipReason =
  'off' | 'extension' | 'empty' | 'slash-command' | 'follow-up' | null;

export function skipReason(input: {
  source: string;
  text: string;
}): SkipReason {
  if (process.env.VIBE_GUARD_OFF) return 'off';
  if (input.source === 'extension') return 'extension';
  const text = input.text.trim();
  if (text === '') return 'empty';
  if (text.startsWith('/')) return 'slash-command';
  if (isFollowUp(text)) return 'follow-up';
  return null;
}

// ---------------------------------------------------------------------------
// Pattern banks — used by the heuristic engine
// ---------------------------------------------------------------------------

/** "You decide / whatever / idc" — the strongest vibe signal. */
export const DELEGATION_MARKERS: readonly RegExp[] = [
  /\byou decide\b/i,
  /\byou figure\b/i,
  /\byou choose\b/i,
  /\bdo whatever\b/i,
  /\bwhatever you\b/i,
  /\bany (?:way|approach) you\b/i,
  /\byour (?:call|judgment)\b/i,
  /\bas you (?:see fit|wish)\b/i,
  /\bhowever you\b/i,
  /\bdon'?t (?:care|ask)\b/i,
  /\bidc\b/i,
  /\bno preference\b/i,
];

/** Imperative openings — evidence the text is directed at an agent. */
export const HANDOFF_MARKERS: readonly RegExp[] = [
  /^(?:implement|write|create|add|fix|refactor|make|build|update|change|remove|delete|move|rename|optimi[sz]e|improve|do)\b/i,
  /\bplease (?:implement|write|create|add|fix|make)\b/i,
  /\bgive me\b/i,
  /\bdo this for me\b/i,
];

/** Concrete anchors — measurements, paths, tests, constraints. */
export const CONCRETE_MARKERS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:ms|µs|us|microseconds?|milliseconds?|sec|seconds?|min|%|reqs?|req\/s|qps|rps)\b/i,
  /(?:^|\s)(?:src|lib|test|tests|app|dist|packages)\//i,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|md|json|ya?ml)\b/i,
  /\b(?:all existing tests?|tests? pass|regression test|coverage|property test)\b/i,
  /\bdon'?t (?:break|change|touch|modify|add new deps?)\b/i,
  /\bmust (?:not )?(?:be|have|return|include|support|run|remain|stay)\b/i,
  /\b(?:worst[- ]case|p95|p99|when n|timeout|benchmark|baseline|latency budget)\b/i,
  /\brequired:?\b|\brequired api\b|\bAPI:?\b|\bthrows? (?:on|if)\b/i,
  /\b(?:function|class|interface|method|signature)\s+\w+/i,
];

/** Map concrete-hit count to a concreteness level. */
const CONCRETE_BAND: ReadonlyArray<readonly [number, Concreteness]> = [
  [3, 'concrete'],
  [2, 'mostly'],
  [1, 'soft'],
  [0, 'vibe'],
] as const;

// ---------------------------------------------------------------------------
// Heuristic engine (Jev's offline twin)
// ---------------------------------------------------------------------------

/**
 * Score a prompt locally — no network, no credentials. Catches surface
 * markers; misses intent-level signals that Jev catches. Returns the same
 * `Verdict` shape as the Jev path so callers don't branch on source.
 */
export function heuristicVerdict(text: string): Verdict {
  const delegating = DELEGATION_MARKERS.some((p) => p.test(text)) ? 1 : 0;
  const aiHandoff = HANDOFF_MARKERS.some((p) => p.test(text)) ? 1 : 0.2;
  const concreteHits = CONCRETE_MARKERS.filter((p) => p.test(text)).length;

  const concreteness =
    CONCRETE_BAND.find(([n]) => concreteHits >= n)?.[1] ?? 'vibe';

  // One-hot distribution so probs shape matches the Jev path exactly.
  const probs: Probs = {
    concrete: 0,
    mostly: 0,
    soft: 0,
    vibe: 0,
    [concreteness]: 1,
  };

  const vibeP = scoreBlend(probs, aiHandoff, delegating);

  return {
    source: 'heuristic',
    vibeP,
    concreteness,
    probs,
    aiHandoff,
    delegating,
  };
}

// ---------------------------------------------------------------------------
// Cumulative tally + status row
// ---------------------------------------------------------------------------

const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
} as const;

export const pct = (rate: number): string =>
  ((rate * 100).toFixed(0) || '0') + '%';

export function colorBands(mean: number): Color {
  if (mean < 0.5) return 'green';
  if (mean < 0.8) return 'yellow';
  return 'red';
}

export function statsFor(scores: ReadonlyArray<Score>): Stats {
  if (scores.length === 0) return { n: 0, mean: 0, high: 0, color: 'green' };
  const mean = scores.reduce((s, e) => s + e.vibeP, 0) / scores.length;
  const high = scores.filter((e) => e.isHigh).length;
  return { n: scores.length, mean, high, color: colorBands(mean) };
}

export function renderStatus(scores: ReadonlyArray<Score>): string | undefined {
  const s = statsFor(scores);
  if (s.n === 0) return undefined;
  const dot = ANSI[s.color] + '●' + ANSI.reset;
  return `${dot} vibe ${pct(s.mean)} · ${s.n} scored · ${s.high} high`;
}

// ---------------------------------------------------------------------------
// Suggestion builder
// ---------------------------------------------------------------------------

export function suggestions(
  probs: Probs,
  aiHandoff: number,
  delegating: number,
): string[] {
  const out: string[] = [];
  if ((probs.vibe ?? 0) >= 0.5) {
    out.push(
      'Add a named measurement ("<100ms at n=10k"), an acceptance criterion ' +
        '("all existing tests pass"), or a target path ("edit src/tree.ts").',
    );
  } else if ((probs.soft ?? 0) >= 0.5) {
    out.push(
      'Add one quantitative constraint or a target path — vague verbs ' +
        '("fix it", "improve this") without numbers read as vibe-coded.',
    );
  }
  if (delegating >= 0.7) {
    out.push(
      'You are handing structure to the AI ("you decide"). Pick it yourself, ' +
        'or say "recommend one and explain why".',
    );
  }
  if ((probs.vibe ?? 0) >= 0.3 && aiHandoff >= 0.7) {
    out.push(
      'Would another engineer know exactly what to build? If not, say it.',
    );
  }
  return out;
}
