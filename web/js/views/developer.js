import { api, confirmDialog, copyText, esc, fmt, icon, openModal, toast } from '../lib.js';

const ENDPOINTS = [
  ['POST', '/api/v1/faxes', 'Key-authenticated send'],
  ['GET', '/api/faxes', 'List with filters'],
  ['GET', '/api/faxes/:id', 'Detail + rendered pages'],
  ['GET', '/api/faxes/:id/pdf', 'Download the PDF'],
  ['POST', '/api/faxes/:id/retry', 'Re-queue a failed fax'],
  ['POST', '/api/faxes/:id/cancel', 'Cancel in flight'],
  ['GET', '/api/contacts', 'Contact directory'],
  ['POST', '/api/contacts', 'Create a contact'],
  ['GET', '/api/numbers', 'Provisioned DIDs'],
  ['GET', '/api/stats?range=30', 'Volume and outcome stats'],
  ['POST', '/api/uploads', 'Multipart PDF / image upload'],
  ['POST', '/api/webhooks/provider', 'Signed carrier callback'],
];

const WEBHOOK_EVENTS = [
  ['fax.delivered', 'Carrier confirmed the transmission'],
  ['fax.failed', 'Transmission failed after the retry budget'],
  ['fax.received', 'An inbound fax arrived on a DID'],
  ['fax.sent', 'A fax was accepted by the provider'],
];

export async function render(ctx) {
  const [keyResult, deliveryResult] = await Promise.all([
    api.get('/api/keys').catch(() => ({ keys: [] })),
    api.get('/api/deliveries').catch(() => ({ deliveries: [] })),
  ]);
  const settings = ctx.state.settings || {};
  const provider = ctx.state.provider || {};
  const base = window.location.origin;
  const keys = keyResult.keys || [];
  const deliveries = deliveryResult.deliveries || [];
  const activeEvents = settings.webhookEvents || [];
  const envRows = (provider.requiredEnv || []).map((name) => ({
    name,
    set: (provider.configuredEnv || []).includes(name),
  }));

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Developer</p>
        <h1 class="page-title">Build on Faxline</h1>
        <p class="page-sub">A single REST surface with key authentication, signed provider callbacks and a simulator so you can integrate before you have a carrier.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--secondary" type="button" data-copy="${esc(`${base}/api/v1/faxes`)}">${icon('copy', 15)} Copy base URL</button>
        <button class="btn btn--primary" type="button" data-action="new-key">${icon('key', 15)} New API key</button>
      </div>
    </header>

    <div class="dev-grid">
      <div class="stack">
        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Quickstart</h2>
              <p class="card__desc">Send a rendered PDF fax with one request</p>
            </div>
            <button class="btn btn--secondary btn--sm" type="button" data-copy="${esc(`curl -X POST ${base}/api/v1/faxes -H "Authorization: Bearer fx_live_YOUR_KEY" -H "Content-Type: application/json" -d '{"to":"+1 212 555 0110","subject":"Signed NDA","note":"Attached for countersignature."}'`)}">${icon('copy', 13)} Copy</button>
          </div>
          <div class="card__body">
            <pre class="code-block"><code><span class="tok-method">curl</span> <span class="tok-method">-X POST</span> <span class="tok-url">${esc(base)}/api/v1/faxes</span> \\
  <span class="tok-key">-H</span> "Authorization: Bearer fx_live_…" \\
  <span class="tok-key">-H</span> "Content-Type: application/json" \\
  <span class="tok-key">-d</span> '{"to":"+1 212 555 0110","subject":"Signed NDA"}'</code></pre>
            <div class="inline-note" style="margin-top:12px">${icon('lock', 14)}
              <span>Keys are stored as SHA-256 hashes and shown once. The server also accepts <code class="mono">X-API-Key</code> for clients that cannot set an Authorization header.</span>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">API keys</h2>
              <p class="card__desc">${keys.length ? `${keys.length} active credential${keys.length === 1 ? '' : 's'}` : 'No keys issued yet'}</p>
            </div>
          </div>
          <div data-keys>
            ${keys.length
              ? keys
                  .map(
                    (key) => `<div class="key-row">
                      <span class="icon-btn" style="pointer-events:none">${icon('key', 15)}</span>
                      <div class="key-row__main">
                        <p class="key-row__name truncate">${esc(key.name)}</p>
                        <p class="key-row__meta">${esc(key.prefix)}… · created ${esc(fmt.date(key.created_at))} · ${key.last_used_at ? `last used ${esc(fmt.relative(key.last_used_at))}` : 'never used'}</p>
                      </div>
                      <span class="tag">${(key.scopes || []).length} scopes</span>
                      <button class="btn btn--ghost btn--sm" type="button" data-revoke="${esc(key.id)}" data-name="${esc(key.name)}">Revoke</button>
                    </div>`,
                  )
                  .join('')
              : `<div class="card__body"><div class="empty" style="border:0;background:none;padding:20px 0">
                  <div class="empty__icon">${icon('key', 18)}</div>
                  <p class="empty__title">No API keys</p>
                  <p class="empty__text">Issue a key to call the REST API from your own systems.</p>
                  <button class="btn btn--primary btn--sm" type="button" data-action="new-key">Create the first key</button>
                </div></div>`}
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Webhooks</h2>
              <p class="card__desc">Signed delivery events for delivered, failed and received faxes</p>
            </div>
            <span class="pill ${settings.webhookUrl ? 'pill--success' : 'pill--muted'}">${settings.webhookUrl ? 'Configured' : 'Not configured'}</span>
          </div>
          <div class="card__body stack">
            <div class="form-grid">
              <div class="field span-2">
                <label class="field__label" for="wh-url">Endpoint URL</label>
                <input class="input input--mono" id="wh-url" placeholder="https://your-app.example.com/hooks/faxline" value="${esc(settings.webhookUrl || '')}" />
                <p class="field__hint">POSTed as JSON with an <code class="mono">X-Faxline-Signature: sha256=…</code> HMAC header.</p>
              </div>
            </div>
            <div class="stack--sm" style="display:flex;flex-direction:column;gap:2px">
              ${WEBHOOK_EVENTS.map(
                ([name, desc]) => `<label class="check" style="align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--border-subtle)">
                  <input type="checkbox" data-event="${esc(name)}" ${activeEvents.includes(name) ? 'checked' : ''} />
                  <span><strong style="font-family:var(--font-mono);font-size:11px">${esc(name)}</strong><br /><span class="faint" style="font-size:var(--fs-1)">${esc(desc)}</span></span>
                </label>`,
              ).join('')}
            </div>
            <div class="field">
              <span class="field__label">Signing secret</span>
              <div class="secret-reveal">
                <code>${esc(settings.webhookSecret || 'not generated')}</code>
                <button class="icon-btn" type="button" data-copy="${esc(settings.webhookSecret || '')}" aria-label="Copy signing secret">${icon('copy', 14)}</button>
              </div>
            </div>
            <div class="row">
              <button class="btn btn--primary" type="button" data-action="save-webhook">${icon('check', 14)} Save webhook</button>
              <span class="faint" style="font-size:var(--fs-1)">Delivery attempts are logged below.</span>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">REST surface</h2>
              <p class="card__desc">Every endpoint the dashboard itself uses</p>
            </div>
          </div>
          <div>
            ${ENDPOINTS.map(
              ([method, path, desc]) => `<div class="endpoint">
                <span class="endpoint__method endpoint__method--${method.toLowerCase()}">${method}</span>
                <button class="endpoint__path" type="button" style="border:0;background:none;text-align:left" data-copy="${esc(base + path.split('?')[0])}">${esc(path)}</button>
                <span class="endpoint__desc">${esc(desc)}</span>
              </div>`,
            ).join('')}
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Webhook deliveries</h2>
              <p class="card__desc">Most recent attempts, newest first</p>
            </div>
          </div>
          ${deliveries.length
            ? `<div class="table-wrap"><table class="table">
                <thead><tr><th>When</th><th>Status</th><th>Code</th><th class="hide-sm">Attempt</th><th>Event</th></tr></thead>
                <tbody>${deliveries
                  .map(
                    (delivery) => `<tr>
                      <td class="num">${esc(fmt.relative(delivery.created_at))}</td>
                      <td><span class="pill pill--${delivery.ok ? 'success' : 'danger'}">${delivery.ok ? 'Delivered' : 'Failed'}</span></td>
                      <td class="num">${esc(delivery.status_code ?? '—')}</td>
                      <td class="num hide-sm">${esc(delivery.attempt ?? 1)}</td>
                      <td class="mono" style="font-size:11px">${esc(delivery.event || delivery.fax_id || '—')}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>`
            : `<div class="card__body"><p class="muted" style="font-size:var(--fs-2)">No webhook attempts yet. Set an endpoint URL above and send a fax.</p></div>`}
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Provider</h2>
              <p class="card__desc">${esc(provider.name || 'Simulator')}</p>
            </div>
            <span class="pill ${provider.mode === 'live' ? 'pill--success' : 'pill--warning'}">${esc(provider.mode || 'simulated')}</span>
          </div>
          <div class="card__body stack">
            <p class="muted" style="font-size:var(--fs-2);line-height:1.55">${esc(provider.description || '')}</p>
            ${provider.fallback
              ? `<div class="inline-note inline-note--warn">${icon('alert', 14)}<span><strong style="color:var(--fg)">${esc(provider.requested)}</strong> was requested but is not configured, so the simulator is active.</span></div>`
              : ''}
            ${envRows.length
              ? `<div class="stack--sm" style="display:flex;flex-direction:column;gap:6px">
                  ${envRows
                    .map(
                      (row) => `<div class="row row--between">
                        <code class="mono" style="font-size:10.5px">${esc(row.name)}</code>
                        <span class="pill pill--${row.set ? 'success' : 'muted'}">${row.set ? 'set' : 'missing'}</span>
                      </div>`,
                    )
                    .join('')}
                </div>`
              : `<p class="faint" style="font-size:var(--fs-1)">No environment variables required.</p>`}
            <div class="divider"></div>
            <div class="stack--sm" style="display:flex;flex-direction:column;gap:8px">
              ${(provider.available || [])
                .map(
                  (adapter) => `<div class="row row--between">
                    <div style="min-width:0">
                      <p style="font-size:var(--fs-2);font-weight:600" class="truncate">${esc(adapter.name)}</p>
                      <p class="faint mono" style="font-size:9.5px">FAX_PROVIDER=${esc(adapter.id)}</p>
                    </div>
                    <span class="pill pill--${adapter.configured ? 'success' : 'muted'}">${adapter.configured ? 'ready' : 'inactive'}</span>
                  </div>`,
                )
                .join('')}
            </div>
            <div class="inline-note">${icon('terminal', 14)}<span>Export <code class="mono">FAX_PROVIDER=telnyx</code> with <code class="mono">TELNYX_API_KEY</code> and <code class="mono">TELNYX_CONNECTION_ID</code>, then restart. Everything else stays the same.</span></div>
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Simulator controls</h2>
              <p class="card__desc">Exercise edge cases without a carrier</p>
            </div>
          </div>
          <div class="card__body stack--sm" style="display:flex;flex-direction:column;gap:8px">
            <button class="btn btn--secondary" type="button" data-action="simulate">${icon('inbox', 14)} Receive an inbound fax</button>
            <button class="btn btn--secondary" type="button" data-action="fail-next">${icon('alert', 14)} Force the next fax to fail</button>
            <a class="btn btn--ghost" href="/api/faxes?direction=out&limit=100" download>${icon('download', 14)} Export transmissions JSON</a>
            <button class="btn btn--ghost" type="button" data-action="reset" style="color:var(--danger)">${icon('rotate', 14)} Reset demo workspace</button>
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Event log</h2>
              <p class="card__desc">Server-side audit trail</p>
            </div>
          </div>
          <div class="card__body stack--sm" style="display:flex;flex-direction:column;gap:10px">
            ${(ctx.state.events || [])
              .slice(0, 12)
              .map(
                (event) => `<div class="row" style="align-items:flex-start;gap:8px">
                  <span class="status-dot ${event.level === 'warn' ? 'status-dot--warn' : event.level === 'error' ? 'status-dot--danger' : 'status-dot--success'}" style="margin-top:5px"></span>
                  <div style="min-width:0">
                    <p style="font-size:var(--fs-1);line-height:1.45">${esc(event.message)}</p>
                    <p class="faint mono" style="font-size:9px">${esc(event.type)} · ${esc(fmt.relative(event.created_at))}</p>
                  </div>
                </div>`,
              )
              .join('') || '<p class="faint" style="font-size:var(--fs-1)">No events recorded.</p>'}
          </div>
        </section>
      </div>
    </div>`;

  return {
    html,
    mount(root) {
      const copy = async (value) => {
        if (!value) return;
        const ok = await copyText(value);
        toast[ok ? 'success' : 'error'](ok ? 'Copied to clipboard' : 'Could not copy');
      };

      root.addEventListener('click', async (event) => {
        const copyButton = event.target.closest('[data-copy]');
        if (copyButton) {
          await copy(copyButton.dataset.copy);
          return;
        }
        const revoke = event.target.closest('[data-revoke]');
        if (revoke) {
          const confirmed = await confirmDialog({
            title: `Revoke “${revoke.dataset.name}”?`,
            message: 'Requests using this key start failing immediately. This cannot be undone.',
            confirmLabel: 'Revoke key',
          });
          if (!confirmed) return;
          try {
            await api.del(`/api/keys/${revoke.dataset.revoke}`);
            toast.success('API key revoked');
            await ctx.reload();
          } catch (error) {
            toast.error('Could not revoke key', error.message);
          }
          return;
        }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'new-key') return openKeyModal(ctx);
        if (action === 'save-webhook') {
          const button = event.target.closest('[data-action="save-webhook"]');
          button.disabled = true;
          try {
            const events = Array.from(root.querySelectorAll('[data-event]'))
              .filter((input) => input.checked)
              .map((input) => input.dataset.event);
            await api.patch('/api/settings', { webhookUrl: root.querySelector('#wh-url').value.trim(), webhookEvents: events });
            toast.success('Webhook saved');
            await ctx.reload();
          } catch (error) {
            toast.error('Could not save webhook', error.message);
            button.disabled = false;
          }
          return;
        }
        if (action === 'simulate') {
          try {
            const { fax } = await api.post('/api/dev/simulate-inbound', {});
            toast.success('Inbound fax received', `${fax.recipient_name} · ${fmt.plural(fax.pages, 'page')}`);
            await ctx.reload();
          } catch (error) {
            toast.error('Simulation failed', error.message);
          }
          return;
        }
        if (action === 'fail-next') {
          try {
            await api.post('/api/dev/fail-next', { enabled: true });
            toast.warn('Next fax will fail', 'The simulator will report a carrier failure so you can test retries.');
          } catch (error) {
            toast.error('Could not arm the simulator', error.message);
          }
          return;
        }
        if (action === 'reset') {
          const confirmed = await confirmDialog({
            title: 'Reset the demo workspace?',
            message: 'All faxes, contacts, numbers, keys and webhook deliveries are replaced with a fresh sample set.',
            confirmLabel: 'Reset workspace',
          });
          if (!confirmed) return;
          try {
            await api.post('/api/dev/reset', {});
            toast.success('Workspace reset');
            setTimeout(() => window.location.reload(), 400);
          } catch (error) {
            toast.error('Reset failed', error.message);
          }
        }
      });
    },
  };
}

function openKeyModal(ctx) {
  const modal = openModal({
    title: 'Create an API key',
    sub: 'The full secret is shown once, immediately after creation.',
    body: `<div class="field">
        <label class="field__label" for="key-name">Key name</label>
        <input class="input" id="key-name" placeholder="Billing automation" autofocus />
        <p class="field__hint">Name it after the system that will hold it.</p>
      </div>
      <div class="form-error" data-error hidden></div>
      <div class="stack--sm" data-secret hidden style="display:none"></div>`,
    footer: `<button class="btn btn--ghost" type="button" data-cancel>Close</button>
      <button class="btn btn--primary" type="button" data-create>Create key</button>`,
  });
  const error = modal.el.querySelector('[data-error]');
  const secretBox = modal.el.querySelector('[data-secret]');
  modal.foot.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  modal.foot.querySelector('[data-create]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { key, apiKey } = await api.post('/api/keys', { name: modal.el.querySelector('#key-name').value.trim() || 'Untitled key' });
      secretBox.hidden = false;
      secretBox.style.display = 'block';
      secretBox.innerHTML = `<p class="field__label">Secret for ${esc(apiKey.name)}</p>
        <div class="secret-reveal"><code>${esc(key)}</code>
          <button class="icon-btn" type="button" data-copy-secret aria-label="Copy secret">${icon('copy', 14)}</button></div>
        <p class="field__hint">Store it now — Faxline only keeps a hash.</p>`;
      secretBox.querySelector('[data-copy-secret]').addEventListener('click', async () => {
        const ok = await copyText(key);
        toast[ok ? 'success' : 'error'](ok ? 'Secret copied' : 'Could not copy');
      });
      event.target.textContent = 'Done';
      event.target.addEventListener('click', () => modal.close(), { once: true });
      toast.success('API key created');
    } catch (requestError) {
      error.hidden = false;
      error.textContent = requestError.message;
      button.disabled = false;
    }
  });
}
