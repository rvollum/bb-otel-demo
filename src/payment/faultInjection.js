// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

'use strict';

const FAULT_FLAG = 'paymentFailure';

const DEFAULT_TTL_MINUTES = 15;

function parseTtlMinutes(env) {
  const raw = env && env.FAULT_INJECTION_MAX_MINUTES;
  const parsed = Number(raw);
  if (!raw || !isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MINUTES;
  return parsed;
}

function isEnvEnabled(env) {
  const val = (env && env.FAULT_INJECTION_ENABLED) || '';
  return val.toLowerCase() === 'true';
}

function createState() {
  return { activeSince: null, expiredLogged: false };
}

/**
 * Decide whether to inject a fault for this request.
 *
 * Parameters are injected so the function is deterministic in tests.
 *
 * @param {object} opts
 * @param {number} opts.rate        - Flag value (0–1 after clamping).
 * @param {boolean} opts.syntheticRequest - True when baggage synthetic_request === 'true'.
 * @param {object} opts.env         - process.env (or a test stub).
 * @param {number} [opts.now]       - Epoch ms; defaults to Date.now().
 * @param {object} opts.state       - Mutable state object from createState().
 * @param {function} [opts.random]  - Returns [0,1); defaults to Math.random.
 * @returns {{ inject: boolean, reason: string, activatedNow: boolean, expiredNow: boolean }}
 */
function decide({ rate, syntheticRequest, env, now = Date.now(), state, random = Math.random }) {
  // Normalize rate.
  let r = Number(rate);
  if (!isFinite(r) || r <= 0) r = 0;
  if (r > 1) r = 1;

  // Flag is off — reset window.
  if (r === 0) {
    state.activeSince = null;
    state.expiredLogged = false;
    return { inject: false, reason: 'flag_off', activatedNow: false, expiredNow: false };
  }

  // First observation of a non-zero rate — start the window.
  let activatedNow = false;
  if (state.activeSince === null) {
    state.activeSince = now;
    activatedNow = true;
  }

  // Environment gate.
  if (!isEnvEnabled(env)) {
    return { inject: false, reason: 'not_enabled', activatedNow, expiredNow: false };
  }

  // Synthetic-only gate.
  if (!syntheticRequest) {
    return { inject: false, reason: 'not_synthetic', activatedNow, expiredNow: false };
  }

  // TTL check.
  const ttlMs = parseTtlMinutes(env) * 60 * 1000;
  if (now - state.activeSince > ttlMs) {
    const expiredNow = !state.expiredLogged;
    state.expiredLogged = true;
    return { inject: false, reason: 'expired', activatedNow: false, expiredNow };
  }

  // Roll.
  if (random() < r) {
    return { inject: true, reason: 'injected', activatedNow, expiredNow: false };
  }
  return { inject: false, reason: 'roll_miss', activatedNow, expiredNow: false };
}

class InjectedFaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InjectedFaultError';
  }
}

module.exports = { FAULT_FLAG, createState, decide, InjectedFaultError, parseTtlMinutes, isEnvEnabled };
