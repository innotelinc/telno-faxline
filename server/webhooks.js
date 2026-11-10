/** Outgoing webhook delivery with HMAC signing and an inspectable delivery log. */
import { hmacSha256, isHttpUrl, nowIso } from './util.js';
import { store } from './store.js';
import { broadcast } from './hub.js';

export async function deliverWebhook(event, fax) {
  const settings = store.settings.get();
  if (!settings.webhookUrl || !isHttpUrl(settings.webhookUrl)) return null;
  if (Array.isArray(settings.webhookEvents) && !settings.webhookEvents.includes(event)) return null;

  const payload = {
    event,
    at: nowIso(),
    fax: {
      id: fax.id,
      direction: fax.direction,
      status: fax.status,
      from: fax.from_number,
      to: fax.to_number,
      recipient: fax.recipient_name,
      subject: fax.subject,
      pages: fax.pages,
      providerRef: fax.provider_ref,
      completedAt: fax.completed_at,
    },
  };
  const body = JSON.stringify(payload);
  const signature = hmacSha256(settings.webhookSecret || 'dev', body);

  try {
    const response = await fetch(settings.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Faxline-Webhooks/1.0',
        'X-Faxline-Event': event,
        'X-Faxline-Signature': `sha256=${signature}`,
      },
      body,
    });
    store.deliveries.insert({
      faxId: fax.id,
      url: settings.webhookUrl,
      statusCode: response.status,
      ok: response.ok,
      attempt: 1,
      payload,
    });
    broadcast('webhook.delivery', { ok: response.ok, event, at: nowIso() });
    store.events.log({
      type: 'webhook.sent',
      level: response.ok ? 'info' : 'warn',
      faxId: fax.id,
      message: `Webhook ${event} → ${response.status}`,
    });
    return response.ok;
  } catch (error) {
    store.deliveries.insert({
      faxId: fax.id,
      url: settings.webhookUrl,
      statusCode: null,
      ok: false,
      attempt: 1,
      payload,
    });
    store.events.log({
      type: 'webhook.failed',
      level: 'error',
      faxId: fax.id,
      message: `Webhook ${event} failed: ${error?.message || 'network error'}`,
    });
    return false;
  }
}
