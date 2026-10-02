// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createState, decide, parseTtlMinutes, isEnvEnabled } = require('../faultInjection');

const ENV_ON  = { FAULT_INJECTION_ENABLED: 'true', FAULT_INJECTION_MAX_MINUTES: '15' };
const ENV_OFF = { FAULT_INJECTION_ENABLED: 'false' };

// Seeded deterministic PRNG (mulberry32).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── parseTtlMinutes ──────────────────────────────────────────────────────────

describe('parseTtlMinutes', () => {
  test('unset → 15', () => assert.equal(parseTtlMinutes({}), 15));
  test('empty string → 15', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: '' }), 15));
  test('non-numeric → 15', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: 'abc' }), 15));
  test('zero → 15', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: '0' }), 15));
  test('negative → 15', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: '-5' }), 15));
  test('1 → 1', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: '1' }), 1));
  test('30 → 30', () => assert.equal(parseTtlMinutes({ FAULT_INJECTION_MAX_MINUTES: '30' }), 30));
});

// ── isEnvEnabled ─────────────────────────────────────────────────────────────

describe('isEnvEnabled', () => {
  test('true → enabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: 'true' }), true));
  test('TRUE → enabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: 'TRUE' }), true));
  test('false → disabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: 'false' }), false));
  test('0 → disabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: '0' }), false));
  test('yes → disabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: 'yes' }), false));
  test('unset → disabled', () => assert.equal(isEnvEnabled({}), false));
  test('empty → disabled', () => assert.equal(isEnvEnabled({ FAULT_INJECTION_ENABLED: '' }), false));
});

// ── decide: flag off / reset ─────────────────────────────────────────────────

describe('decide: flag off', () => {
  test('rate 0 → flag_off', () => {
    const s = createState();
    const r = decide({ rate: 0, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'flag_off');
    assert.equal(s.activeSince, null);
  });

  test('negative rate → flag_off', () => {
    const s = createState();
    const r = decide({ rate: -1, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(r.reason, 'flag_off');
  });

  test('NaN rate → flag_off', () => {
    const s = createState();
    const r = decide({ rate: NaN, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(r.reason, 'flag_off');
  });

  test('undefined rate → flag_off', () => {
    const s = createState();
    const r = decide({ rate: undefined, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(r.reason, 'flag_off');
  });

  test('string rate → flag_off', () => {
    const s = createState();
    const r = decide({ rate: 'high', syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(r.reason, 'flag_off');
  });

  test('flag_off resets state.activeSince', () => {
    const s = createState();
    s.activeSince = 1000;
    decide({ rate: 0, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(s.activeSince, null);
  });

  test('flag_off resets state.expiredLogged', () => {
    const s = createState();
    s.expiredLogged = true;
    decide({ rate: 0, syntheticRequest: true, env: ENV_ON, state: s });
    assert.equal(s.expiredLogged, false);
  });
});

// ── decide: env gate ─────────────────────────────────────────────────────────

describe('decide: env gate', () => {
  test('env not enabled → not_enabled, no injection', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: true, env: ENV_OFF, state: s, random: () => 0 });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'not_enabled');
  });

  test('env unset → not_enabled', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: true, env: {}, state: s });
    assert.equal(r.reason, 'not_enabled');
  });
});

// ── decide: synthetic gate ───────────────────────────────────────────────────

describe('decide: synthetic gate', () => {
  test('non-synthetic → not_synthetic, no injection', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: false, env: ENV_ON, state: s, random: () => 0 });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'not_synthetic');
  });

  test('synthetic_request=false (string) → not_synthetic', () => {
    // syntheticRequest is already a boolean derived from baggage; 'false' !== 'true' so it's false
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: false, env: ENV_ON, state: s });
    assert.equal(r.reason, 'not_synthetic');
  });
});

// ── decide: rate clamping ────────────────────────────────────────────────────

describe('decide: rate clamping', () => {
  test('rate 5 clamped to 1 → always injects (random=0)', () => {
    const s = createState();
    const r = decide({ rate: 5, syntheticRequest: true, env: ENV_ON, state: s, random: () => 0 });
    assert.equal(r.inject, true);
  });

  test('rate 1, random=0.9999 → injects', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: true, env: ENV_ON, state: s, random: () => 0.9999 });
    assert.equal(r.inject, true);
  });
});

// ── decide: boundary ─────────────────────────────────────────────────────────

describe('decide: boundary', () => {
  test('rate 0.75, random 0.7499 → injects', () => {
    const s = createState();
    const r = decide({ rate: 0.75, syntheticRequest: true, env: ENV_ON, state: s, random: () => 0.7499 });
    assert.equal(r.inject, true);
    assert.equal(r.reason, 'injected');
  });

  test('rate 0.75, random 0.75 → roll_miss', () => {
    const s = createState();
    const r = decide({ rate: 0.75, syntheticRequest: true, env: ENV_ON, state: s, random: () => 0.75 });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'roll_miss');
  });
});

// ── decide: statistical sanity ───────────────────────────────────────────────

describe('decide: statistical sanity', () => {
  test('10,000 draws at rate 0.5 land within 48%–52%', () => {
    const prng = mulberry32(0xdeadbeef);
    let hits = 0;
    for (let i = 0; i < 10000; i++) {
      const s = createState();
      const r = decide({ rate: 0.5, syntheticRequest: true, env: ENV_ON, state: s, random: prng });
      if (r.inject) hits++;
    }
    const pct = hits / 10000;
    assert.ok(pct >= 0.48 && pct <= 0.52, `Expected ~50%, got ${(pct * 100).toFixed(1)}%`);
  });
});

// ── decide: TTL / expiry ─────────────────────────────────────────────────────

describe('decide: TTL', () => {
  const ttlEnv = { FAULT_INJECTION_ENABLED: 'true', FAULT_INJECTION_MAX_MINUTES: '15' };
  const SEC = 1000;
  const MIN = 60 * SEC;

  test('injects at t=0', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    assert.equal(r.inject, true);
  });

  test('injects at t=14:59', () => {
    const s = createState();
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    const r = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 14 * MIN + 59 * SEC, state: s, random: () => 0 });
    assert.equal(r.inject, true);
  });

  test('does not inject at t=15:01 (expired, expiredNow=true first time)', () => {
    const s = createState();
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    const r = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 15 * MIN + SEC, state: s, random: () => 0 });
    assert.equal(r.inject, false);
    assert.equal(r.reason, 'expired');
    assert.equal(r.expiredNow, true);
  });

  test('expiredNow=false on subsequent expired calls', () => {
    const s = createState();
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 16 * MIN, state: s, random: () => 0 });
    const r = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 17 * MIN, state: s, random: () => 0 });
    assert.equal(r.expiredNow, false);
  });

  test('cycling flag off then back on re-arms the window', () => {
    const s = createState();
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 16 * MIN, state: s, random: () => 0 });
    // Flag goes to 0 (resets state).
    decide({ rate: 0, syntheticRequest: true, env: ttlEnv, now: 17 * MIN, state: s });
    // Flag back to 0.5 — new window.
    const r = decide({ rate: 0.5, syntheticRequest: true, env: ttlEnv, now: 18 * MIN, state: s, random: () => 0 });
    assert.equal(r.inject, true);
    assert.equal(r.activatedNow, true);
  });

  test('activatedNow=true only on first observation', () => {
    const s = createState();
    const r1 = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: 0, state: s, random: () => 0 });
    const r2 = decide({ rate: 1, syntheticRequest: true, env: ttlEnv, now: SEC, state: s, random: () => 0 });
    assert.equal(r1.activatedNow, true);
    assert.equal(r2.activatedNow, false);
  });
});

// ── decide: suppression precedence ──────────────────────────────────────────

describe('decide: suppression precedence', () => {
  // not_enabled wins over not_synthetic wins over expired
  test('not_enabled wins when env gate is off and not synthetic', () => {
    const s = createState();
    const r = decide({ rate: 1, syntheticRequest: false, env: ENV_OFF, state: s });
    assert.equal(r.reason, 'not_enabled');
  });

  test('not_synthetic wins when env enabled but not synthetic, regardless of TTL', () => {
    const s = createState();
    // Push past TTL so expired would trigger if not_synthetic didn't win first.
    decide({ rate: 1, syntheticRequest: true, env: ENV_ON, now: 0, state: s, random: () => 0 });
    const r = decide({ rate: 1, syntheticRequest: false, env: ENV_ON, now: 16 * 60 * 60000, state: s });
    assert.equal(r.reason, 'not_synthetic');
  });
});
