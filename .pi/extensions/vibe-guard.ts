/**
 * vibe-guard — pre-flight vibe-coding warning with cumulative session stats.
 *
 * This file is the pi wiring. The pure scoring logic — rubric-style
 * formulas, regex pattern banks, follow-up detection, tally math, color
 * bands, suggestion builder — lives in `../../src/scoring.ts` and is
 * unit-tested there with `node --test`.
 *
 * Flow:
 *   1. `input` event → `scorePrompt` (auto engine → Jev, falls back to heuristic)
 *   2. Record the verdict's `vibeP` in the per-cwd tally, update the footer row
 *   3. If `vibeP >= THRESHOLD`, warn — dialog in TUI mode, notify otherwise
 *   4. Declining returns the text to the editor (TUI only)
 *
 * Load:
 *   pi -e ./.pi/extensions/vibe-guard.ts        (one-off)
 *   # or keep .pi/extensions/ in the project and it loads on trust.
 *
 * Tuning:
 *   VIBE_GUARD_THRESHOLD=0.8   (default) minimum vibeP to warn AND red threshold
 *   VIBE_GUARD_ENGINE=auto     (default) Jev when TYPESAFE_API_KEY is set, else
 *                              the local heuristic in src/scoring.ts.
 *                              `jev` or `heuristic` force one engine.
 *   VIBE_GUARD_OFF=1           disable without unloading
 *   VIBE_GUARD_DEBUG=1         log the verdict to stderr (headless testing)
 *
 * Skipped (never classified, never tallied): slash commands, empty input,
 * and known conversational follow-ups ("ok", "yes go on", "continue").
 * Short imperatives like "fix it" ARE scored — length is not a skip signal.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  type Score,
  type Source,
  type Verdict,
  heuristicVerdict,
  pct,
  renderStatus,
  scoreBlend,
  skipReason,
  statsFor,
  suggestions as buildSuggestions,
  threshold,
} from '../../src/scoring.js';

// ---------------------------------------------------------------------------
// Per-workspace tally state. Module-level Map survives input events within a
// single session; cleared on session_start with a fresh reason.
// ---------------------------------------------------------------------------

const sessionScores = new Map<string, Score[]>();

function recordScore(cwd: string, vibeP: number, isHigh: boolean): void {
  const list = sessionScores.get(cwd) ?? [];
  list.push({ vibeP, isHigh });
  sessionScores.set(cwd, list);
}

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

function engineMode(): 'auto' | 'jev' | 'heuristic' {
  return (process.env.VIBE_GUARD_ENGINE ?? 'auto').toLowerCase() as
    'auto' | 'jev' | 'heuristic';
}

/** Whether the TargetSafe SDK has credentials to call Jev. */
function hasJevCredentials(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

// ---------------------------------------------------------------------------
// Jev rubric — the questions sent to the classifier. Mirrors the local
// heuristic's labels so both engines emit the same Verdict shape.
// ---------------------------------------------------------------------------

const QUESTIONS = {
  concreteness: {
    type: 'choice' as const,
    instructions: "How concrete is the user's coding request?",
    criteria: {
      concrete:
        '0 (concrete spec) — explicit acceptance criteria, named measurements, referenced tests/files.',
      mostly:
        '1 (mostly concrete) — problem + approach stated, missing a constraint or two.',
      soft: '2 (soft spec) — direct but vague verbs / numbers — "fix it", "improve this", no quant target.',
      vibe: '3 (full vibe code) — "you figure it out", "whatever you think", no success criteria the AI could be measured against.',
    },
  },
  aiHandoff: {
    type: 'bool' as const,
    instructions: 'Does this read as an instruction TO an AI?',
    criteria: {
      true: 'Implements, writes, makes this work, do this for me, give me code, etc.',
      false: 'Reads as explanation, narration, or human discussion.',
    },
  },
  delegating: {
    type: 'bool' as const,
    instructions:
      'Does this ask an AI to pick structure / deps / naming / approach?',
    criteria: {
      true: 'AI picks structure / dependencies / naming / approach.',
      false: 'Decisions are stated or implied as resolved.',
    },
  },
};

// ---------------------------------------------------------------------------
// Two scoring paths. Both return Verdict with vibeP already computed.
// ---------------------------------------------------------------------------

async function jevVerdict(
  ctx: ExtensionContext,
  text: string,
): Promise<Verdict | null> {
  const jev = ctx.modelRegistry.findOfType(
    'classifier',
    'typesafe',
    'jev-latest',
  );
  if (!jev) return null;
  const result = await ctx.modelRegistry.classify(
    jev,
    { state: { prompt: text }, questions: QUESTIONS },
    { signal: ctx.signal },
  );
  if (result.stopReason !== 'stop') return null;

  const concreteness = result.answers.concreteness;
  const aiHandoff = result.answers.aiHandoff;
  const delegating = result.answers.delegating;
  if (
    concreteness?.type !== 'choice' ||
    aiHandoff?.type !== 'bool' ||
    delegating?.type !== 'bool'
  ) {
    return null;
  }

  return {
    source: 'jev' as Source,
    vibeP: scoreBlend(
      concreteness.probabilities,
      aiHandoff.probability,
      delegating.probability,
    ),
    concreteness: concreteness.choice as Verdict['concreteness'],
    probs: concreteness.probabilities,
    aiHandoff: aiHandoff.probability,
    delegating: delegating.probability,
  };
}

/** Score with the configured engine. Falls back to the heuristic. */
async function scorePrompt(
  ctx: ExtensionContext,
  text: string,
): Promise<Verdict> {
  const mode = engineMode();
  const wantJev = mode === 'jev' || (mode === 'auto' && hasJevCredentials());
  if (wantJev) {
    const verdict = await jevVerdict(ctx, text);
    if (verdict) return verdict;
  }
  return heuristicVerdict(text);
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    if (event.reason === 'new' || event.reason === 'startup') {
      sessionScores.delete(ctx.cwd);
    }
  });

  pi.on('input', async (event, ctx) => {
    if (skipReason(event) !== null) return { action: 'continue' };
    const text = event.text.trim();

    const verdict = await scorePrompt(ctx, text);

    const isHigh = verdict.vibeP >= threshold();
    recordScore(ctx.cwd, verdict.vibeP, isHigh);
    const list = sessionScores.get(ctx.cwd) ?? [];
    const status = renderStatus(list);
    if (status !== undefined) ctx.ui.setStatus('vibe', status);

    if (process.env.VIBE_GUARD_DEBUG) {
      const s = statsFor(list);
      process.stderr.write(
        `[vibe-guard] engine=${verdict.source} vibeP=${pct(verdict.vibeP)} ` +
          `concreteness=${verdict.concreteness} ai=${pct(verdict.aiHandoff)} ` +
          `delegating=${pct(verdict.delegating)} ` +
          `warn=${isHigh ? 'yes' : 'no'}\n`,
      );
      process.stderr.write(
        `[vibe-guard] session: n=${s.n} mean=${pct(s.mean)} ` +
          `high=${s.high} color=${s.color}\n`,
      );
    }

    if (!isHigh) return { action: 'continue' };

    const lines = [
      `This prompt reads as vibe coding (${pct(verdict.vibeP)} · ${verdict.concreteness}).`,
      '',
      ...buildSuggestions(
        verdict.probs,
        verdict.aiHandoff,
        verdict.delegating,
      ).map((s) => `• ${s}`),
    ];
    const summary = lines.join('\n');

    // No dialog UI (print/json mode): warn if possible, let it through.
    if (!ctx.hasUI) {
      ctx.ui.notify(summary, 'warning');
      return { action: 'continue' };
    }

    const send = await ctx.ui.confirm(
      '⚠ Vibe coding detected',
      `${summary}\n\nSend anyway?`,
    );
    if (send) return { action: 'continue' };

    // Declined: put the text back so the user can rephrase, and consume it.
    ctx.ui.setEditorText(event.text);
    ctx.ui.notify(
      'Returned to the editor — tighten the spec and resend.',
      'info',
    );
    return { action: 'handled' };
  });
}
