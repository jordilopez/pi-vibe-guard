// tests/scoring.test.ts — unit tests for the pure scoring logic.
//
// Run with:  node --test tests/
//
// These cover everything that used to require booting pi: the blend
// formula, the follow-up predicate, the heuristic engine, the tally math,
// and the color bands. No network, no credentials, milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOST,
  colorBands,
  expectedConcreteness,
  FOLLOW_UP_WORDS,
  heuristicVerdict,
  isFollowUp,
  pct,
  renderStatus,
  scoreBlend,
  skipReason,
  statsFor,
  suggestions,
  type Probs,
} from '../src/scoring.ts';

// ---------------------------------------------------------------------------
// expectedConcreteness
// ---------------------------------------------------------------------------

test('expectedConcreteness: one-hot levels map to 0, 1/3, 2/3, 1', () => {
  assert.equal(expectedConcreteness({ concrete: 1 }), 0);
  assert.ok(Math.abs(expectedConcreteness({ mostly: 1 }) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(expectedConcreteness({ soft: 1 }) - 2 / 3) < 1e-9);
  assert.equal(expectedConcreteness({ vibe: 1 }), 1);
});

test('expectedConcreteness: empty probs are treated as all-zero', () => {
  assert.equal(expectedConcreteness({}), 0);
});

test('expectedConcreteness: a distribution is its weighted mean', () => {
  // 50/50 between concrete (0) and vibe (1) → 0.5
  assert.equal(expectedConcreteness({ concrete: 0.5, vibe: 0.5 }), 0.5);
});

// ---------------------------------------------------------------------------
// scoreBlend
// ---------------------------------------------------------------------------

test('scoreBlend: fully concrete + no delegation is 0', () => {
  assert.equal(scoreBlend({ concrete: 1 }, 0, 0), 0);
});

test('scoreBlend: fully vague + full delegation is 1', () => {
  assert.equal(scoreBlend({ vibe: 1 }, 1, 1), 1);
});

test('scoreBlend: soft (2) does NOT tie vibe (3)', () => {
  const soft = scoreBlend({ soft: 1 }, 1, 1);
  const vibe = scoreBlend({ vibe: 1 }, 1, 1);
  assert.ok(vibe > soft, `vibe (${vibe}) should beat soft (${soft})`);
});

test('scoreBlend: BOOST controls the delegation weight', () => {
  // A fully concrete prompt with full delegation scores exactly BOOST·1.
  assert.equal(scoreBlend({ concrete: 1 }, 1, 1), BOOST);
});

test('scoreBlend: output is clamped to [0, 1]', () => {
  const p: Probs = { concrete: 1 };
  assert.equal(scoreBlend(p, 1, 1) >= 0, true);
  assert.equal(scoreBlend(p, 1, 1) <= 1, true);
});

// ---------------------------------------------------------------------------
// isFollowUp
// ---------------------------------------------------------------------------

test('isFollowUp: single acknowledgements are follow-ups', () => {
  for (const t of ['ok', 'yes', 'no', 'sure', 'thanks', 'continue', 'lgtm']) {
    assert.equal(isFollowUp(t), true, `${t} should be a follow-up`);
  }
});

test('isFollowUp: multi-word conversational replies are follow-ups', () => {
  for (const t of [
    'yes go on',
    'sounds good',
    'looks good',
    'ok please continue',
  ]) {
    assert.equal(isFollowUp(t), true, `${t} should be a follow-up`);
  }
});

test('isFollowUp: punctuation and case do not matter', () => {
  assert.equal(isFollowUp('OK!'), true);
  assert.equal(isFollowUp('Sounds good.'), true);
});

test('isFollowUp: short imperatives are NOT follow-ups', () => {
  for (const t of ['fix it', 'do whatever', 'do it', 'make it better']) {
    assert.equal(isFollowUp(t), false, `${t} should be scored`);
  }
});

test('isFollowUp: anything over 4 words is not a follow-up', () => {
  assert.equal(isFollowUp('ok go on please continue now'), false);
});

test('isFollowUp: empty input is not a follow-up (it is a separate skip)', () => {
  assert.equal(isFollowUp(''), false);
  assert.equal(isFollowUp('   '), false);
});

test('isFollowUp: the vocabulary deliberately excludes do/it', () => {
  assert.equal(FOLLOW_UP_WORDS.has('do'), false);
  assert.equal(FOLLOW_UP_WORDS.has('it'), false);
});

// ---------------------------------------------------------------------------
// skipReason
// ---------------------------------------------------------------------------

test('skipReason: extension-sourced input is skipped', () => {
  assert.equal(
    skipReason({ source: 'extension', text: 'fix it' }),
    'extension',
  );
});

test('skipReason: empty and whitespace-only input is skipped', () => {
  assert.equal(skipReason({ source: 'interactive', text: '' }), 'empty');
  assert.equal(skipReason({ source: 'interactive', text: '   ' }), 'empty');
});

test('skipReason: slash commands are skipped', () => {
  assert.equal(
    skipReason({ source: 'interactive', text: '/help' }),
    'slash-command',
  );
});

test('skipReason: conversational follow-ups are skipped', () => {
  assert.equal(
    skipReason({ source: 'interactive', text: 'yes go on' }),
    'follow-up',
  );
});

test('skipReason: a normal prompt is scored', () => {
  assert.equal(
    skipReason({ source: 'interactive', text: 'fix the parser' }),
    null,
  );
});

test('skipReason: short imperatives are scored, not skipped by length', () => {
  assert.equal(skipReason({ source: 'interactive', text: 'do it' }), null);
  assert.equal(skipReason({ source: 'interactive', text: 'fix it' }), null);
});

// ---------------------------------------------------------------------------
// heuristicVerdict
// ---------------------------------------------------------------------------

test('heuristicVerdict: full delegation + no concrete anchors is maximally vibe', () => {
  const v = heuristicVerdict(
    "Fix the parser. I don't care how, just make it work. You decide the data structures.",
  );
  assert.equal(v.source, 'heuristic');
  assert.equal(v.concreteness, 'vibe');
  assert.equal(v.delegating, 1);
  assert.equal(v.aiHandoff, 1);
  assert.ok(v.vibeP > 0.9, `expected high vibeP, got ${v.vibeP}`);
});

test('heuristicVerdict: a spec with many concrete anchors is concrete', () => {
  const v = heuristicVerdict(
    'Implement a Red-Black tree insert at src/tree.ts. Required API: insert(value: T): void. Worst-case latency < 100us at n=100,000. All existing tests must pass.',
  );
  assert.equal(v.concreteness, 'concrete');
  assert.equal(v.delegating, 0);
  assert.ok(v.vibeP < 0.3, `expected low vibeP, got ${v.vibeP}`);
});

test('heuristicVerdict: a non-imperative statement has low aiHandoff', () => {
  const v = heuristicVerdict('the function returns the previous value');
  assert.ok(v.aiHandoff < 0.5, `expected low aiHandoff, got ${v.aiHandoff}`);
});

test('heuristicVerdict: the emitted probs are a one-hot distribution', () => {
  const v = heuristicVerdict('fix the parser');
  const total = Object.values(v.probs).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
  assert.equal(v.probs[v.concreteness], 1);
});

test('heuristicVerdict: vibeP matches scoreBlend of its own fields', () => {
  const v = heuristicVerdict(
    'refactor the auth module, you decide the structure',
  );
  assert.equal(v.vibeP, scoreBlend(v.probs, v.aiHandoff, v.delegating));
});

// ---------------------------------------------------------------------------
// statsFor
// ---------------------------------------------------------------------------

test('statsFor: empty input is green with zeroes', () => {
  assert.deepEqual(statsFor([]), { n: 0, mean: 0, high: 0, color: 'green' });
});

test('statsFor: mean is the arithmetic mean of vibeP', () => {
  const s = statsFor([
    { vibeP: 0.2, isHigh: false },
    { vibeP: 0.4, isHigh: false },
  ]);
  assert.equal(s.n, 2);
  assert.ok(Math.abs(s.mean - 0.3) < 1e-9);
});

test('statsFor: high counts only turns flagged isHigh', () => {
  const s = statsFor([
    { vibeP: 0.9, isHigh: true },
    { vibeP: 0.85, isHigh: true },
    { vibeP: 0.1, isHigh: false },
  ]);
  assert.equal(s.high, 2);
});

test('statsFor: color bands split at 0.5 and 0.8', () => {
  assert.equal(statsFor([{ vibeP: 0.49, isHigh: false }]).color, 'green');
  assert.equal(statsFor([{ vibeP: 0.5, isHigh: false }]).color, 'yellow');
  assert.equal(statsFor([{ vibeP: 0.79, isHigh: false }]).color, 'yellow');
  assert.equal(statsFor([{ vibeP: 0.8, isHigh: true }]).color, 'red');
});

test('colorBands: boundaries are inclusive on the upper band', () => {
  assert.equal(colorBands(0.4999), 'green');
  assert.equal(colorBands(0.5), 'yellow');
  assert.equal(colorBands(0.7999), 'yellow');
  assert.equal(colorBands(0.8), 'red');
});

// ---------------------------------------------------------------------------
// renderStatus
// ---------------------------------------------------------------------------

test('renderStatus: undefined until there is data', () => {
  assert.equal(renderStatus([]), undefined);
});

test('renderStatus: contains the mean, count, and high count', () => {
  const out = renderStatus([
    { vibeP: 0.9, isHigh: true },
    { vibeP: 0.3, isHigh: false },
  ]);
  assert.ok(out !== undefined);
  assert.match(out, /vibe 60%/);
  assert.match(out, /2 scored/);
  assert.match(out, /1 high/);
});

test('renderStatus: uses an ANSI color matching the band', () => {
  const red = renderStatus([{ vibeP: 0.95, isHigh: true }]);
  assert.ok(red?.includes('\x1b[31m'));
  const green = renderStatus([{ vibeP: 0.1, isHigh: false }]);
  assert.ok(green?.includes('\x1b[32m'));
});

// ---------------------------------------------------------------------------
// pct
// ---------------------------------------------------------------------------

test('pct: rounds to whole percent', () => {
  assert.equal(pct(0), '0%');
  assert.equal(pct(0.5), '50%');
  assert.equal(pct(0.916), '92%');
  assert.equal(pct(1), '100%');
});

// ---------------------------------------------------------------------------
// suggestions
// ---------------------------------------------------------------------------

test('suggestions: a fully vague prompt gets the concreteness hint', () => {
  const out = suggestions({ vibe: 1 }, 1, 1);
  assert.ok(out.some((s) => /named measurement/i.test(s)));
});

test('suggestions: delegating alone gets the delegation hint', () => {
  const out = suggestions({ concrete: 1 }, 0.5, 0.9);
  assert.ok(out.some((s) => /handing structure/i.test(s)));
});

test('suggestions: a tight concrete prompt gets no hints', () => {
  const out = suggestions({ concrete: 1 }, 0.9, 0.1);
  assert.deepEqual(out, []);
});

test('suggestions: soft gets the quantitative-constraint hint', () => {
  const out = suggestions({ soft: 1 }, 0.9, 0.1);
  assert.ok(out.some((s) => /quantitative constraint/i.test(s)));
});
