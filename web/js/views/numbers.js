import { api, confirmDialog, esc, fmt, icon, openModal, toast } from '../lib.js';

const REGIONS = [
  { code: 'US-CA', label: 'United States · California', monthly: 495, prefix: '+1 (415) 555-' },
  { code: 'US-NY', label: 'United States · New York', monthly: 395, prefix: '+1 (212) 555-' },
  { code: 'US-IL', label: 'United States · Illinois', monthly: 295, prefix: '+1 (312) 555-' },
  { code: 'US-TX', label: 'United States · Texas', monthly: 295, prefix: '+1 (512) 555-' },
  { code: 'GB-LND', label: 'United Kingdom · London', monthly: 695, prefix: '+44 20 7946 0' },
  { code: 'DE-BE', label: 'Germany · Berlin', monthly: 645, prefix: '+49 30 5555 0' },
];

export async function render(ctx) {
  const { numbers } = await api.get('/api/numbers');
  const provider = ctx.state.provider;

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Numbers</p>
        <h1 class="page-title">Fax numbers</h1>
        <p class="page-sub">DIDs that send and receive on your behalf. Set a default, pause inbound, or provision an additional number.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--primary" type="button" data-action="provision">${icon('plus', 15)} Provision number</button>
      </div>
    </header>

    ${provider?.mode === 'simulated'
      ? `<div class="inline-note inline-note--info">${icon('server', 14)}
          <span><strong style="color:var(--fg)">Simulator mode.</strong> Numbers are provisioned locally for demonstration. Point <code class="mono">FAX_PROVIDER</code> at a live adapter to attach real DIDs.</span>
        </div>`
      : `<div class="inline-note">${icon('server', 14)}<span>Numbers are registered with ${esc(provider?.name || 'your provider')}.</span></div>`}

    <div class="number-grid">
      ${numbers
        .map(
          (number) => `<article class="number-card">
            <div class="number-card__head">
              <div class="grow">
                <p class="number-card__num">${esc(number.number)}</p>
                <p class="number-card__label">${esc(number.label)} · ${esc(number.region)}</p>
              </div>
              <div class="stack--sm" style="align-items:flex-end">
                ${number.is_default ? '<span class="pill pill--accent">Default</span>' : ''}
                <span class="pill ${number.status === 'active' ? 'pill--success' : 'pill--warning'}">${esc(number.status)}</span>
              </div>
            </div>
            <div class="number-card__stats">
              <div class="number-card__stat"><span>Inbound</span><strong>${fmt.num(number.inbound_count)}</strong></div>
              <div class="number-card__stat"><span>Monthly</span><strong>${esc(fmt.money(number.monthly_cents))}</strong></div>
              <div class="number-card__stat"><span>Mode</span><strong>${number.capabilities.includes('receive') ? '2-way' : 'out'}</strong></div>
            </div>
            <div class="row row--wrap" style="gap:6px;padding:10px var(--space-4) 0">
              <span class="tag">${icon('send', 10)} send</span>
              ${number.capabilities.includes('receive') ? `<span class="tag">${icon('inbox', 10)} receive</span>` : ''}
            </div>
            <div class="number-card__foot">
              ${number.is_default
                ? '<span class="faint" style="font-size:var(--fs-1)">Used by default in the composer</span>'
                : `<button class="btn btn--secondary btn--sm" type="button" data-default="${esc(number.id)}">Make default</button>`}
              <div class="row" style="gap:2px;margin-left:auto">
                <button class="icon-btn" type="button" data-edit="${esc(number.id)}" aria-label="Edit ${esc(number.number)}">${icon('settings', 13)}</button>
                <button class="icon-btn" type="button" data-release="${esc(number.id)}" aria-label="Release ${esc(number.number)}" ${number.is_default ? 'disabled' : ''}>${icon('trash', 13)}</button>
              </div>
            </div>
          </article>`,
        )
        .join('')}
    </div>

    <section class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">How numbering works</h2>
          <p class="card__desc">What each capability means for delivery</p>
        </div>
      </div>
      <div class="card__body">
        <div class="grid grid--3">
          <div class="stack--sm">
            <p class="panel-title">${icon('send', 14)} Sending</p>
            <p class="muted" style="font-size:var(--fs-2);line-height:1.55">Outbound caller ID. Some carriers require the sender to own the number; keep the default number aligned with your registered business identity.</p>
          </div>
          <div class="stack--sm">
            <p class="panel-title">${icon('inbox', 14)} Receiving</p>
            <p class="muted" style="font-size:var(--fs-2);line-height:1.55">Inbound pages are captured, rendered and dropped into the inbox. Disable receiving on numbers reserved for outbound campaigns only.</p>
          </div>
          <div class="stack--sm">
            <p class="panel-title">${icon('webhook', 14)} Callbacks</p>
            <p class="muted" style="font-size:var(--fs-2);line-height:1.55">Provider status updates arrive at <code class="mono">/api/webhooks/provider</code> and are verified with an HMAC signature before touching a fax record.</p>
          </div>
        </div>
      </div>
    </section>`;

  return {
    html,
    mount(root) {
      const regionOptions = REGIONS.map(
        (region) => `<option value="${region.code}" data-monthly="${region.monthly}">${esc(region.label)} · ${fmt.money(region.monthly)}/mo</option>`,
      ).join('');

      const openProvision = () => {
        const modal = openModal({
          title: 'Provision a fax number',
          sub: 'Numbers are allocated instantly in simulator mode.',
          body: `<div class="form-grid">
              <div class="field span-2"><label class="field__label" for="n-region">Region</label>
                <select class="select" id="n-region">${regionOptions}</select></div>
              <div class="field span-2"><label class="field__label" for="n-number">Fax number</label>
                <input class="input input--mono" id="n-number" value="${esc(REGIONS[0].prefix)}0142" /></div>
              <div class="field span-2"><label class="field__label" for="n-label">Label</label>
                <input class="input" id="n-label" placeholder="Support desk" /></div>
              <label class="check span-2"><input type="checkbox" id="n-receive" checked /> <span>Enable inbound receiving</span></label>
            </div>
            <div class="form-error" data-error hidden></div>`,
          footer: `<button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
            <button class="btn btn--primary" type="button" data-create>Provision</button>`,
        });
        const error = modal.el.querySelector('[data-error]');
        const regionSelect = modal.el.querySelector('#n-region');
        regionSelect.addEventListener('change', () => {
          const option = regionSelect.selectedOptions[0];
          const region = REGIONS.find((item) => item.code === option.value);
          if (region) modal.el.querySelector('#n-number').value = `${region.prefix}0142`;
        });
        modal.foot.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
        modal.foot.querySelector('[data-create]').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          const region = REGIONS.find((item) => item.code === regionSelect.value) || REGIONS[0];
          try {
            await api.post('/api/numbers', {
              number: modal.el.querySelector('#n-number').value,
              label: modal.el.querySelector('#n-label').value || 'New number',
              region: region.code,
              capabilities: modal.el.querySelector('#n-receive').checked ? ['send', 'receive'] : ['send'],
              monthly_cents: region.monthly,
            });
            modal.close();
            toast.success('Number provisioned');
            await ctx.reload();
          } catch (requestError) {
            error.hidden = false;
            error.textContent = requestError.message;
            button.disabled = false;
          }
        });
      };

      root.querySelector('[data-action="provision"]').addEventListener('click', openProvision);

      root.addEventListener('click', async (event) => {
        const defaultButton = event.target.closest('[data-default]');
        const editButton = event.target.closest('[data-edit]');
        const releaseButton = event.target.closest('[data-release]');

        if (defaultButton) {
          try {
            await api.patch(`/api/numbers/${defaultButton.dataset.default}`, { is_default: true });
            toast.success('Default number updated');
            await ctx.reload();
          } catch (error) {
            toast.error('Could not set default', error.message);
          }
          return;
        }

        if (editButton) {
          const number = numbers.find((item) => item.id === editButton.dataset.edit);
          const modal = openModal({
            title: 'Edit number',
            sub: number.number,
            body: `<div class="stack">
                <div class="field"><label class="field__label" for="e-label">Label</label>
                  <input class="input" id="e-label" value="${esc(number.label)}" /></div>
                <div class="field"><label class="field__label" for="e-status">Status</label>
                  <select class="select" id="e-status">
                    <option value="active"${number.status === 'active' ? ' selected' : ''}>Active</option>
                    <option value="paused"${number.status === 'paused' ? ' selected' : ''}>Paused</option>
                  </select></div>
                <div class="switch-row">
                  <div class="switch-row__text"><span class="switch-row__title">Receive faxes</span>
                    <span class="switch-row__desc">When disabled, inbound calls to this DID are rejected at the carrier.</span></div>
                  <label class="switch"><input type="checkbox" id="e-receive" ${number.capabilities.includes('receive') ? 'checked' : ''} /><span class="switch__track"></span></label>
                </div>
              </div>
              <div class="form-error" data-error hidden></div>`,
            footer: `<button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
              <button class="btn btn--primary" type="button" data-save>Save</button>`,
          });
          modal.foot.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
          modal.foot.querySelector('[data-save]').addEventListener('click', async () => {
            try {
              await api.patch(`/api/numbers/${number.id}`, {
                label: modal.el.querySelector('#e-label').value,
                status: modal.el.querySelector('#e-status').value,
                capabilities: modal.el.querySelector('#e-receive').checked
                  ? ['send', 'receive']
                  : ['send'],
              });
              modal.close();
              toast.success('Number updated');
              await ctx.reload();
            } catch (error) {
              const errorEl = modal.el.querySelector('[data-error]');
              errorEl.hidden = false;
              errorEl.textContent = error.message;
            }
          });
          return;
        }

        if (releaseButton) {
          const number = numbers.find((item) => item.id === releaseButton.dataset.release);
          const confirmed = await confirmDialog({
            title: `Release ${number.number}?`,
            message: `The number stops sending and receiving immediately. Historical faxes stay in the workspace.`,
            confirmLabel: 'Release number',
          });
          if (!confirmed) return;
          try {
            await api.del(`/api/numbers/${number.id}`);
            toast.success('Number released');
            await ctx.reload();
          } catch (error) {
            toast.error('Could not release number', error.message);
          }
        }
      });
    },
  };
}
