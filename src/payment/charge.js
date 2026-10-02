// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { ATTR_ERROR_TYPE } = require('@opentelemetry/semantic-conventions');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const { FAULT_FLAG, createState, decide, InjectedFaultError } = require('./faultInjection');

const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('demo.payment.transactions', {
  unit: '{transaction}',
});
const faultInjectedCounter = meter.createCounter('demo.payment.fault_injected', {
  unit: '{request}',
});
const faultSuppressedCounter = meter.createCounter('demo.payment.fault_injection_suppressed', {
  unit: '{request}',
});

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

const faultState = createState();

/** Return random element from given array */
function random(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');

  try {
    const baggage = propagation.getBaggage(context.active());
    const syntheticRequest = baggage?.getEntry('synthetic_request')?.value === 'true';

    if (syntheticRequest) {
      span.setAttribute('user_agent.synthetic.type', 'test');
    }

    await OpenFeature.setProviderAndWait(flagProvider);

    const flagDetails = await OpenFeature.getClient().getNumberDetails(FAULT_FLAG, 0);
    const { value: flagValue, variant: flagVariant, reason: flagReason } = flagDetails;

    // Always record flag state on the span regardless of whether we inject.
    span.setAttributes({
      'feature_flag.key': FAULT_FLAG,
      'feature_flag.result.variant': flagVariant !== undefined ? String(flagVariant) : String(flagValue),
      'feature_flag.result.reason': flagReason || 'UNKNOWN',
    });

    const { inject, reason, activatedNow, expiredNow } = decide({
      rate: flagValue,
      syntheticRequest,
      env: process.env,
      state: faultState,
    });

    if (activatedNow) {
      const ttl = Number(process.env.FAULT_INJECTION_MAX_MINUTES) > 0
        ? Number(process.env.FAULT_INJECTION_MAX_MINUTES) : 15;
      logger.warn(
        { flag: FAULT_FLAG, rate: flagValue, variant: flagVariant, ttlMinutes: ttl,
          envEnabled: process.env.FAULT_INJECTION_ENABLED, synthetic: syntheticRequest },
        'Fault injection flag paymentFailure is active',
      );
    }

    if (expiredNow) {
      logger.warn(
        { flag: FAULT_FLAG },
        `Fault injection expired after ${process.env.FAULT_INJECTION_MAX_MINUTES || 15} minutes; ` +
        'set paymentFailure to off and back on to re-arm',
      );
    }

    if (inject) {
      span.setAttributes({
        'chaos.injected': true,
        'chaos.flag': FAULT_FLAG,
        'chaos.variant': String(flagVariant),
        'demo.user_context.loyalty_level': 'gold',
      });
      faultInjectedCounter.add(1, { flag: FAULT_FLAG, variant: String(flagVariant) });
      throw new InjectedFaultError('Payment request failed. Invalid token. demo.user_context.loyalty_level=gold');
    }

    if (['not_enabled', 'not_synthetic', 'expired'].includes(reason)) {
      faultSuppressedCounter.add(1, { flag: FAULT_FLAG, reason });
    }

    const {
      creditCardNumber: number,
      creditCardCvv: cvv,
      creditCardExpirationYear: year,
      creditCardExpirationMonth: month
    } = request.creditCard;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const lastFourDigits = number.substr(-4);
    const transactionId = uuidv4();

    const card = cardValidator(number);
    const { card_type: cardType, valid } = card.getCardDetails();

    const loyalty_level = random(LOYALTY_LEVEL);

    span.setAttributes({
      'demo.payment.card_type': cardType,
      'demo.payment.card_valid': valid,
      'demo.user_context.loyalty_level': loyalty_level,
      'demo.payment.card_number': number,
      'demo.payment.card_cvv': cvv
    });

    if (!valid) {
      throw new Error('Credit card info is invalid.');
    }

    if (!['visa', 'mastercard'].includes(cardType)) {
      throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
    }

    if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
      throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
    }

    // Do not charge synthetic requests.
    if (syntheticRequest) {
      span.setAttribute('demo.payment.charged', false);
    } else {
      span.setAttribute('demo.payment.charged', true);
    }

    const enduserId = baggage?.getEntry('enduser.id')?.value;
    if (enduserId) {
      span.setAttribute('enduser.id', enduserId);
    }

    const { units, nanos, currencyCode } = request.amount;
    logger.info({ transactionId, cardType, lastFourDigits, amount: { units, nanos, currencyCode }, loyalty_level }, 'Transaction complete.');
    transactionsCounter.add(1, { 'demo.payment.currency': currencyCode });

    return { transactionId };
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.setAttribute(ATTR_ERROR_TYPE, err.name || 'Error');

    throw err;
  } finally {
    span.end();
  }
};
