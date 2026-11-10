/**
 * Delivery engine: owns the state machine for a fax attempt and pushes changes
 * onto the SSE hub. Simulated providers are advanced on timers; live providers
 * hand off to the network and settle from provider webhooks.
 */
import { broadcast } from './hub.js';
import { store } from './store.js';
import { getProvider } from './providers.js';
import { nowIso, pick, seededRandom, uid } from './util.js';
import { buildFaxRender } from './render.js';
import { deliverWebhook } from './webhooks.js';

const timers = new Map();
const random = seededRandom(Date.now() % 100000);

let forceFailNext = false;
let scheduler = null;

const FAILURES = [
  { code: 'NO_ANSWER', message: 'The receiving fax machine did not answer after 4 attempts.' },
  { code: 'LINE_BUSY', message: 'The destination line stayed busy for the full retry window.' },
  { code: 'DOCUMENT_ERROR', message: 'The carrier rejected the document: unsupported page encoding.' },
  { code: 'CARRIER_REJECTED', message: 'The carrier rejected the destination number as unreachable.' },
];

export function priceFor(pages, quality) {
  const rates = { standard: 7, fine: 9, ultra: 12 };
  return (Number(pages) || 1) * (rates[quality] ?? rates.standard);
}

export function appendTimeline(fax, status, label, detail) {
  const timeline = Array.isArray(fax.timeline) ? fax.timeline.slice() : [];
  timeline.push({ at: nowIso(), status, label, detail });
  return timeline;
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function later(id, delay, fn) {
  clearTimer(id);
  const timer = setTimeout(() => {
    timers.delete(id);
    try {
      fn();
    } catch (error) {
      console.error(`[engine] task ${id} failed:`, error);
    }
  }, delay);
  timer.unref?.();
  timers.set(id, timer);
}

function publish(fax, extra = {}) {
  if (!fax) return;
  broadcast('fax.updated', { fax, ...extra });
  broadcast('stats.stale', { at: nowIso() });
}

function setStatus(fax, status, patch = {}) {
  const updated = store.faxes.update(fax.id, { status, ...patch });
  publish(updated);
  return updated;
}

async function documentsFor(fax) {
  const collected = [];
  for (const doc of fax.documents || []) {
    const stored = store.files.read(doc.id);
    if (stored) collected.push({ ...stored.meta, buffer: stored.buffer });
  }
  return collected;
}

function settleSimulated(faxId) {
  const fax = store.faxes.get(faxId);
  if (!fax || fax.status !== 'sending') return;
  const shouldFail = forceFailNext || random() < 0.06;
  if (forceFailNext) forceFailNext = false;

  if (shouldFail) {
    const failure = pick(FAILURES, random);
    const updated = setStatus(fax, 'failed', {
      completed_at: nowIso(),
      error_code: failure.code,
      error_message: failure.message,
      cost_cents: 0,
      timeline: appendTimeline(fax, 'failed', 'Failed', failure.message),
    });
    store.events.log({
      type: 'fax.failed',
      level: 'error',
      faxId: fax.id,
      message: `${fax.subject || 'Fax'} to ${fax.to_number} failed: ${failure.code}`,
    });
    broadcast('fax.failed', { fax: updated });
    void deliverWebhook('fax.failed', updated);
    return;
  }

  const duration = 12 + fax.pages * 6 + Math.floor(random() * 12);
  const updated = setStatus(fax, 'delivered', {
    completed_at: nowIso(),
    duration_sec: duration,
    cost_cents: priceFor(fax.pages, fax.quality),
    error_code: null,
    error_message: null,
    timeline: appendTimeline(
      fax,
      'delivered',
      'Delivered',
      `${fax.pages} page(s) confirmed by the receiving device`,
    ),
  });
  store.events.log({
    type: 'fax.delivered',
    faxId: fax.id,
    message: `${fax.subject || 'Fax'} delivered to ${fax.to_number}`,
  });
  broadcast('fax.delivered', { fax: updated });
  void deliverWebhook('fax.delivered', updated);
}

export async function dispatch(faxId) {
  const fax = store.faxes.get(faxId);
  if (!fax || fax.direction !== 'out') return null;
  if (['delivered', 'failed', 'cancelled', 'received'].includes(fax.status)) return fax;

  if (fax.scheduled_at && new Date(fax.scheduled_at).getTime() > Date.now() + 1500) {
    const scheduled = setStatus(fax, 'scheduled');
    return scheduled;
  }

  const provider = getProvider();
  const queued = setStatus(fax, 'queued', {
    provider: provider.id,
    attempts: (fax.attempts || 0) + 1,
    timeline: appendTimeline(fax, 'queued', 'Queued', `Accepted by ${provider.name}`),
  });

  later(faxId, 450, async () => {
    const current = store.faxes.get(faxId);
    if (!current || current.status !== 'queued') return;
    const sending = setStatus(current, 'sending', {
      timeline: appendTimeline(current, 'sending', 'Transmitting', `Dialing ${current.to_number}`),
    });

    try {
      const files = await documentsFor(sending);
      const callbackUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:4321'}/api/webhooks/provider`;
      const result = await provider.send({ fax: sending, files, callbackUrl });
      const latest = store.faxes.get(faxId);
      if (!latest) return;
      store.faxes.update(faxId, { provider_ref: result.providerRef ?? latest.provider_ref });
      broadcast('fax.updated', { fax: store.faxes.get(faxId) });

      if (provider.mode === 'simulated') {
        const delay = 900 + (latest.pages || 1) * 380;
        later(faxId, delay, () => settleSimulated(faxId));
      } else {
        store.events.log({
          type: 'fax.submitted',
          faxId,
          message: `${latest.subject || 'Fax'} submitted to ${provider.name} (${result.providerRef ?? 'no ref'}).`,
        });
      }
    } catch (error) {
      const latest = store.faxes.get(faxId);
      if (!latest) return;
      const message = error?.message || 'Provider rejected the transmission.';
      setStatus(latest, 'failed', {
        completed_at: nowIso(),
        error_code: 'PROVIDER_ERROR',
        error_message: message,
        cost_cents: 0,
        timeline: appendTimeline(latest, 'failed', 'Failed', message),
      });
      store.events.log({ type: 'fax.failed', level: 'error', faxId, message });
      broadcast('fax.failed', { fax: store.faxes.get(faxId) });
    }
  });

  return queued;
}

export async function retryFax(faxId) {
  const fax = store.faxes.get(faxId);
  if (!fax) return null;
  if (fax.attempts >= fax.max_attempts) {
    throw new Error(`Retry limit reached (${fax.max_attempts} attempts).`);
  }
  const reset = store.faxes.update(faxId, {
    status: 'queued',
    error_code: null,
    error_message: null,
    completed_at: null,
    duration_sec: null,
    cost_cents: 0,
    timeline: appendTimeline(fax, 'queued', 'Requeued', `Retry ${fax.attempts + 1} of ${fax.max_attempts}`),
  });
  broadcast('fax.updated', { fax: reset });
  store.events.log({ type: 'fax.retried', faxId, message: `Retry requested for ${fax.subject || 'fax'}.` });
  return dispatch(faxId);
}

export async function cancelFax(faxId) {
  const fax = store.faxes.get(faxId);
  if (!fax) return null;
  if (['delivered', 'received', 'cancelled'].includes(fax.status)) {
    throw new Error(`A ${fax.status} fax cannot be cancelled.`);
  }
  clearTimer(faxId);
  const provider = getProvider();
  if (fax.status === 'sending' && provider.mode === 'live') {
    await provider.cancel(fax).catch(() => false);
  }
  const updated = store.faxes.update(faxId, {
    status: 'cancelled',
    completed_at: nowIso(),
    timeline: appendTimeline(fax, 'cancelled', 'Cancelled', 'Cancelled by the operator'),
  });
  publish(updated);
  store.events.log({ type: 'fax.cancelled', faxId, message: `Cancelled ${fax.subject || 'fax'}.` });
  return updated;
}

export function simulateInbound({ numberId = null } = {}) {
  const settings = store.settings.get();
  const target = numberId ? store.numbers.get(numberId) : store.numbers.default();
  if (!target) throw new Error('No fax number is available to receive this fax.');
  const senders = [
    { name: 'Acme Holdings', number: '+1 (212) 555-0110' },
    { name: 'Bayview Medical', number: '+1 (650) 555-0193' },
    { name: 'Kanto Freight', number: '+49 30 5555 0188' },
    { name: 'State Records Office', number: '+1 (916) 555-0155' },
    { name: 'Lumen Insurance', number: '+1 (312) 555-0164' },
  ];
  const sender = pick(senders, random);
  const pages = 1 + Math.floor(random() * 4);
  const subject = pick(
    [
      'Inbound referral — new patient',
      'Remittance advice correction',
      'Countersigned agreement',
      'Delivery exception notice',
      'Records request follow-up',
      'Customs documentation',
    ],
    random,
  );
  const createdAt = nowIso();
  const render = buildFaxRender({
    settings,
    from: sender.number,
    to: target.number,
    recipientName: `${settings.workspaceName} · Fax desk`,
    subject,
    note: `Inbound fax received on ${target.number}. ${pages} page(s) captured at 200 dpi, fine resolution.`,
    documents: [],
    createdAt,
    direction: 'in',
  });
  const fax = store.faxes.insert({
    direction: 'in',
    status: 'received',
    from_number: sender.number,
    to_number: target.number,
    recipient_name: sender.name,
    subject,
    pages,
    quality: 'fine',
    created_at: createdAt,
    completed_at: createdAt,
    duration_sec: 11 + pages * 5,
    provider: getProvider().id,
    provider_ref: `sim_in_${uid('x').slice(2, 8)}`,
    attempts: 1,
    read: false,
    timeline: [
      { at: createdAt, status: 'received', label: 'Received', detail: `${pages} page(s) from ${sender.number}` },
    ],
    render,
    tags: ['Inbound'],
  });
  store.numbers.incrementInbound(target.id);
  store.events.log({
    type: 'fax.received',
    faxId: fax.id,
    message: `Inbound fax from ${sender.name} (${pages} pages).`,
  });
  broadcast('fax.received', { fax });
  broadcast('stats.stale', { at: createdAt });
  return fax;
}

export function setForceFail(next = true) {
  forceFailNext = Boolean(next);
  return forceFailNext;
}

export function startScheduler() {
  if (scheduler) return;
  scheduler = setInterval(() => {
    try {
      const { items } = store.faxes.list({ direction: 'out', limit: 60 });
      const now = Date.now();
      for (const fax of items) {
        if (fax.status !== 'scheduled' || !fax.scheduled_at) continue;
        if (new Date(fax.scheduled_at).getTime() <= now) {
          store.events.log({ type: 'fax.released', faxId: fax.id, message: `Scheduled fax released: ${fax.subject}` });
          dispatch(fax.id);
        }
      }
    } catch (error) {
      console.error('[engine] scheduler tick failed:', error);
    }
  }, 15000);
  scheduler.unref?.();
}

export function nextScheduledAt() {
  const { items } = store.faxes.list({ status: 'scheduled', direction: 'out', limit: 20 });
  const times = items.map((fax) => new Date(fax.scheduled_at).getTime()).filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function engineSummary() {
  const active = store.faxes.list({ status: 'active', limit: 50 }).items;
  return {
    active: active.length,
    timers: timers.size,
    nextScheduledAt: nextScheduledAt(),
    forceFailNext,
  };
}

// Recover work that was queued right before a restart.
export function resumePending() {
  const { items } = store.faxes.list({ direction: 'out', limit: 100 });
  for (const fax of items) {
    if (fax.status === 'sending' || fax.status === 'queued') {
      store.faxes.update(fax.id, {
        status: 'queued',
        timeline: appendTimeline(fax, 'queued', 'Recovered', 'Resumed after a server restart'),
      });
      dispatch(fax.id);
    }
  }
  startScheduler();
  return true;
}
