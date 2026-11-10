/**
 * Provider adapters.
 *
 * Faxline talks to a provider through one narrow interface so the platform is
 * plug-and-play: the built-in simulator needs no account, and live adapters are
 * enabled purely through environment variables.
 *
 *   { id, name, mode, requiredEnv, isConfigured(), send({fax, files, callbackUrl}), cancel(fax) }
 */
import { digits, money } from './util.js';

const env = (key) => String(process.env[key] ?? '').trim();

const simulator = {
  id: 'simulator',
  name: 'Faxline Simulator',
  mode: 'simulated',
  docsUrl: 'https://example.com/faxline/providers',
  requiredEnv: [],
  isConfigured: () => true,
  describe: () => 'Every transmission is rendered locally and simulated end-to-end. No account or key needed.',
  async send({ fax }) {
    return {
      providerRef: `sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      accepted: true,
      transport: 'simulated',
      note: `Simulated ${fax.pages} page(s) at ${fax.quality} quality.`,
    };
  },
  async cancel() {
    return true;
  },
};

const telnyx = {
  id: 'telnyx',
  name: 'Telnyx Programmable Fax',
  mode: 'live',
  docsUrl: 'https://developers.telnyx.com/docs/fax',
  requiredEnv: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'],
  isConfigured: () => Boolean(env('TELNYX_API_KEY') && env('TELNYX_CONNECTION_ID')),
  describe: () => 'Live: sends the rendered PDF to Telnyx, which delivers it to the PSTN and reports status by webhook.',
  async send({ fax, files, callbackUrl }) {
    const form = new FormData();
    form.set('connection_id', env('TELNYX_CONNECTION_ID'));
    form.set('from', digits(env('FAX_FROM_NUMBER') || fax.from_number));
    form.set('to', digits(fax.to_number));
    form.set('webhook_url', callbackUrl);
    form.set('webhook_failover_url', callbackUrl);
    form.set('monochrome', 'true');
    const document = files[0];
    if (!document) throw new Error('Telnyx requires at least one document to transmit.');
    form.append(
      'media',
      new Blob([document.buffer], { type: document.mime || 'application/pdf' }),
      document.name || 'fax.pdf',
    );

    const response = await fetch('https://api.telnyx.com/v2/faxes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('TELNYX_API_KEY')}` },
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx responded ${response.status}`;
      throw new Error(detail);
    }
    return { providerRef: payload?.data?.id ?? null, accepted: true, transport: 'telnyx' };
  },
  async cancel(fax) {
    if (!fax.provider_ref) return false;
    const response = await fetch(`https://api.telnyx.com/v2/faxes/${fax.provider_ref}/actions/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('TELNYX_API_KEY')}` },
    });
    return response.ok;
  },
};

const webhook = {
  id: 'webhook',
  name: 'Custom HTTP provider',
  mode: 'live',
  docsUrl: '',
  requiredEnv: ['FAX_SEND_URL'],
  isConfigured: () => Boolean(env('FAX_SEND_URL')),
  describe: () =>
    'Live: POSTs the fax envelope and base64 document to your own gateway, which must reply with { "providerRef", "status" }. Report progress to /api/webhooks/provider.',
  async send({ fax, files, callbackUrl }) {
    const document = files[0];
    const response = await fetch(env('FAX_SEND_URL'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env('FAX_SEND_TOKEN') ? { Authorization: `Bearer ${env('FAX_SEND_TOKEN')}` } : {}),
      },
      body: JSON.stringify({
        faxId: fax.id,
        from: digits(fax.from_number),
        to: digits(fax.to_number),
        subject: fax.subject,
        pages: fax.pages,
        quality: fax.quality,
        callbackUrl,
        document: document
          ? { name: document.name, mime: document.mime, base64: document.buffer.toString('base64') }
          : null,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Provider gateway responded ${response.status}`);
    return {
      providerRef: payload.providerRef ?? payload.id ?? null,
      accepted: payload.status !== 'failed',
      transport: 'custom',
    };
  },
  async cancel(fax) {
    if (!env('FAX_CANCEL_URL') || !fax.provider_ref) return false;
    const response = await fetch(env('FAX_CANCEL_URL'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env('FAX_SEND_TOKEN') ? { Authorization: `Bearer ${env('FAX_SEND_TOKEN')}` } : {}),
      },
      body: JSON.stringify({ providerRef: fax.provider_ref }),
    });
    return response.ok;
  },
};

const REGISTRY = { simulator, telnyx, webhook };

export function getProvider() {
  const requested = (env('FAX_PROVIDER') || 'simulator').toLowerCase();
  const provider = REGISTRY[requested];
  if (!provider) return simulator;
  if (!provider.isConfigured()) return simulator;
  return provider;
}

export function providerStatus() {
  const requested = (env('FAX_PROVIDER') || 'simulator').toLowerCase();
  const active = getProvider();
  return {
    requested,
    active: active.id,
    name: active.name,
    mode: active.mode,
    description: active.describe(),
    docsUrl: active.docsUrl,
    requiredEnv: active.requiredEnv,
    configuredEnv: active.requiredEnv.filter((key) => Boolean(env(key))),
    fallback: requested !== active.id,
    available: Object.values(REGISTRY).map((provider) => ({
      id: provider.id,
      name: provider.name,
      mode: provider.mode,
      requiredEnv: provider.requiredEnv,
      configured: provider.isConfigured(),
      description: provider.describe(),
    })),
  };
}

export function estimateCost(pages, quality) {
  const rates = { standard: 7, fine: 9, ultra: 12 };
  const rate = rates[quality] ?? rates.standard;
  return { cents: pages * rate, rate, label: money(pages * rate) };
}
