import { api, confirmDialog, debounce, esc, fmt, icon, toast } from '../lib.js';

const PANELS = [
  { key: 'workspace', label: 'Workspace', icon: 'overview' },
  { key: 'cover', label: 'Cover page', icon: 'file' },
  { key: 'notifications', label: 'Notifications', icon: 'mail' },
  { key: 'appearance', label: 'Appearance', icon: 'sun' },
  { key: 'data', label: 'Data & reset', icon: 'server' },
];

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

const COVER_TEMPLATES = [
  { key: 'branded', label: 'Branded', desc: 'Accent rule, workspace mark and a signature block.' },
  { key: 'classic', label: 'Classic', desc: 'Formal letterhead with a centred rule.' },
  { key: 'minimal', label: 'Minimal', desc: 'Type only — no rules or fills.' },
];

export async function render(ctx) {
  const settings = ctx.state.settings || {};
  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Workspace</p>
        <h1 class="page-title">Settings</h1>
        <p class="page-sub">Identity, cover artwork, notifications and retention. Changes apply to new transmissions and to the whole workspace immediately.</p>
      </div>
      <div class="page-head__actions">
        <span class="pill pill--muted">${icon('server', 11)} ${esc(ctx.state.provider?.name || 'Simulator')}</span>
      </div>
    </header>

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${PANELS.map(
          (panel, index) =>
            `<button type="button" data-panel="${panel.key}" aria-current="${index === 0}">${icon(panel.icon, 14)} ${esc(panel.label)}</button>`,
        ).join('')}
      </nav>

      <div data-panels>
        <section class="card settings-section" data-section="workspace">
          <div class="card__head">
            <div><h2 class="card__title">Workspace identity</h2><p class="card__desc">Used on cover pages, exports and the topbar</p></div>
          </div>
          <div class="card__body">
            <div class="form-grid">
              <div class="field"><label class="field__label" for="s-workspace">Workspace name</label>
                <input class="input" id="s-workspace" value="${esc(settings.workspaceName || '')}" /></div>
              <div class="field"><label class="field__label" for="s-sender">Sender name on faxes</label>
                <input class="input" id="s-sender" value="${esc(settings.senderName || '')}" /></div>
              <div class="field"><label class="field__label" for="s-user">Your name</label>
                <input class="input" id="s-user" value="${esc(settings.userName || '')}" /></div>
              <div class="field"><label class="field__label" for="s-role">Role</label>
                <input class="input" id="s-role" value="${esc(settings.userRole || '')}" /></div>
              <div class="field"><label class="field__label" for="s-email">Email</label>
                <input class="input" id="s-email" type="email" value="${esc(settings.userEmail || '')}" /></div>
              <div class="field"><label class="field__label" for="s-tz">Timezone</label>
                <select class="select" id="s-tz">
                  ${TIMEZONES.map((zone) => `<option value="${zone}"${zone === settings.timezone ? ' selected' : ''}>${zone.replace('_', ' ')}</option>`).join('')}
                </select></div>
            </div>
          </div>
          <div class="card__foot">
            <span class="faint" style="font-size:var(--fs-1)">Timezone drives day buckets in analytics.</span>
            <button class="btn btn--primary btn--sm" type="button" data-save="workspace">Save changes</button>
          </div>
        </section>

        <section class="card settings-section" data-section="cover" hidden>
          <div class="card__head">
            <div><h2 class="card__title">Cover page</h2><p class="card__desc">The first page of every rendered fax</p></div>
            <span class="pill pill--accent">${esc(settings.accent || '#757cf2')}</span>
          </div>
          <div class="card__body">
            <div class="split" style="grid-template-columns:minmax(0,1fr) 300px">
              <div class="stack">
                <div class="option-row" data-templates>
                  ${COVER_TEMPLATES.map(
                    (template) => `<button class="option-card" type="button" data-template="${template.key}" aria-pressed="${(settings.coverTemplate || 'branded') === template.key}">
                      <span class="option-card__label">${esc(template.label)}</span>
                      <span class="option-card__meta">${esc(template.desc)}</span>
                    </button>`,
                  ).join('')}
                </div>
                <div class="form-grid">
                  <div class="field"><label class="field__label" for="s-header">Cover header</label>
                    <input class="input" id="s-header" maxlength="60" value="${esc(settings.coverHeader || '')}" /></div>
                  <div class="field"><label class="field__label" for="s-accent">Accent colour</label>
                    <div class="row">
                      <input class="input input--mono" id="s-accent" value="${esc(settings.accent || '#757cf2')}" />
                      <input type="color" id="s-accent-picker" value="${esc(settings.accent || '#757cf2')}" aria-label="Pick accent colour" style="width:38px;height:34px;padding:2px;border-radius:6px;border:1px solid var(--border);background:var(--surface)" />
                    </div></div>
                  <div class="field span-2"><label class="field__label" for="s-footer">Confidentiality footer</label>
                    <textarea class="textarea" id="s-footer" style="min-height:70px">${esc(settings.coverFooter || '')}</textarea></div>
                </div>
                <div class="switch-row">
                  <div class="switch-row__text"><span class="switch-row__title">Page numbers</span>
                    <span class="switch-row__desc">Print “PAGE n / total” in the footer of each attachment page.</span></div>
                  <label class="switch"><input type="checkbox" id="s-pagenums" ${settings.showPageNumbers !== false ? 'checked' : ''} /><span class="switch__track"></span></label>
                </div>
              </div>
              <div class="stack--sm">
                <div class="preview-frame" data-cover-preview style="min-height:280px">
                  <div class="skeleton" style="width:100%;height:300px"></div>
                </div>
                <p class="field__hint">Live render from the same layout engine that produces the PDF.</p>
              </div>
            </div>
          </div>
          <div class="card__foot">
            <span class="faint" style="font-size:var(--fs-1)">Existing faxes keep the artwork they were sent with.</span>
            <button class="btn btn--primary btn--sm" type="button" data-save="cover">Save cover</button>
          </div>
        </section>

        <section class="card settings-section" data-section="notifications" hidden>
          <div class="card__head">
            <div><h2 class="card__title">Notifications</h2><p class="card__desc">In-app alerts and the delivery digest</p></div>
          </div>
          <div class="card__body">
            <div class="switch-row">
              <div class="switch-row__text"><span class="switch-row__title">Delivery confirmations</span>
                <span class="switch-row__desc">Toast when a transmission is confirmed by the receiving device.</span></div>
              <label class="switch"><input type="checkbox" id="s-notify-delivered" ${settings.notifyDelivered !== false ? 'checked' : ''} /><span class="switch__track"></span></label>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><span class="switch-row__title">Failure alerts</span>
                <span class="switch-row__desc">Toast with the carrier error code when a fax fails.</span></div>
              <label class="switch"><input type="checkbox" id="s-notify-failed" ${settings.notifyFailed !== false ? 'checked' : ''} /><span class="switch__track"></span></label>
            </div>
            <div class="switch-row">
              <div class="switch-row__text"><span class="switch-row__title">Daily digest</span>
                <span class="switch-row__desc">Summary of volume, failures and spend for the previous day.</span></div>
              <label class="switch"><input type="checkbox" id="s-digest" ${settings.dailyDigest ? 'checked' : ''} /><span class="switch__track"></span></label>
            </div>
            <div class="inline-note" style="margin-top:var(--space-4)">${icon('mail', 14)}
              <span>Email delivery needs an SMTP or transactional email provider; this build keeps notifications in-app and in the webhook stream.</span>
            </div>
          </div>
          <div class="card__foot">
            <span></span>
            <button class="btn btn--primary btn--sm" type="button" data-save="notifications">Save notification preferences</button>
          </div>
        </section>

        <section class="card settings-section" data-section="appearance" hidden>
          <div class="card__head">
            <div><h2 class="card__title">Appearance</h2><p class="card__desc">Theme and density for this workspace</p></div>
          </div>
          <div class="card__body stack">
            <div class="stack--sm">
              <p class="eyebrow">Theme</p>
              <div class="theme-options" data-theme-options>
                ${[
                  ['light', 'Light'],
                  ['dark', 'Dark'],
                  ['system', 'System'],
                ]
                  .map(
                    ([key, label]) => `<button class="theme-swatch" type="button" data-theme="${key}" aria-pressed="${(settings.theme || 'system') === key}">
                      <span class="theme-swatch__preview" style="background:${key === 'dark' ? '#181c1f' : key === 'light' ? '#ffffff' : 'linear-gradient(120deg,#ffffff 50%,#181c1f 50%)'}">
                        <span class="theme-swatch__side" style="background:${key === 'dark' ? '#232a2e' : '#eef2f7'}"></span>
                        <span></span>
                      </span>
                      <span class="theme-swatch__label">${label}</span>
                    </button>`,
                  )
                  .join('')}
              </div>
            </div>
            <div class="stack--sm">
              <p class="eyebrow">Density</p>
              <div class="row" data-density-options>
                ${[
                  ['comfortable', 'Comfortable', 'Default row height and padding'],
                  ['compact', 'Compact', 'Tighter tables for high-volume queues'],
                ]
                  .map(
                    ([key, label, desc]) => `<button class="option-card" type="button" style="width:200px" data-density="${key}" aria-pressed="${(settings.density || 'comfortable') === key}">
                      <span class="option-card__label">${label}</span>
                      <span class="option-card__meta">${desc}</span>
                    </button>`,
                  )
                  .join('')}
              </div>
            </div>
          </div>
        </section>

        <section class="card settings-section" data-section="data" hidden>
          <div class="card__head">
            <div><h2 class="card__title">Data & retention</h2><p class="card__desc">Where records live and how long they are kept</p></div>
          </div>
          <div class="card__body stack">
            <div class="form-grid">
              <div class="field"><label class="field__label" for="s-retention">Retention (days)</label>
                <input class="input input--mono" id="s-retention" type="number" min="1" max="3650" value="${esc(settings.retentionDays || 90)}" />
                <p class="field__hint">Applied on the next maintenance pass; nothing is deleted immediately.</p></div>
              <div class="field"><label class="field__label">Storage</label>
                <div class="inline-note" style="margin-top:6px">${icon('server', 14)}<span>SQLite (<code class="mono">data/faxline.db</code>) plus files under <code class="mono">data/files</code>. Back up both together.</span></div></div>
            </div>
            <div class="row">
              <button class="btn btn--primary btn--sm" type="button" data-save="data">Save retention</button>
              <a class="btn btn--secondary btn--sm" href="/api/faxes?direction=out&limit=100" download>${icon('download', 13)} Export transmissions</a>
            </div>
          </div>
        </section>

        <section class="card danger-zone" data-section="data" hidden style="margin-top:var(--space-4)">
          <div class="card__head">
            <div><h2 class="card__title">Danger zone</h2><p class="card__desc">Destructive actions cannot be undone</p></div>
          </div>
          <div class="card__body row row--between" style="gap:var(--space-4);flex-wrap:wrap">
            <div style="min-width:240px;flex:1">
              <p style="font-size:var(--fs-2);font-weight:600">Reset the demo workspace</p>
              <p class="muted" style="font-size:var(--fs-1);line-height:1.5">Replaces every fax, contact, number, key and webhook log with the generated sample set. Useful before a demo.</p>
            </div>
            <button class="btn btn--danger" type="button" data-action="reset">${icon('trash', 14)} Reset workspace</button>
          </div>
        </section>
      </div>
    </div>`;

  return {
    html,
    mount(root) {
      const sections = Array.from(root.querySelectorAll('[data-section]'));
      const navButtons = Array.from(root.querySelectorAll('[data-panel]'));

      const showPanel = (key) => {
        sections.forEach((section) => {
          section.hidden = section.dataset.section !== key;
        });
        navButtons.forEach((button) => button.setAttribute('aria-current', String(button.dataset.panel === key)));
      };
      navButtons.forEach((button) => button.addEventListener('click', () => showPanel(button.dataset.panel)));

      const patch = async (body, button, message) => {
        if (button) button.disabled = true;
        try {
          const result = await api.patch('/api/settings', body);
          ctx.state.settings = result.settings;
          document.documentElement.dataset.density = result.settings.density || 'comfortable';
          toast.success(message);
          if (button) button.disabled = false;
        } catch (error) {
          toast.error('Could not save', error.message);
          if (button) button.disabled = false;
        }
      };

      const value = (selector) => root.querySelector(selector)?.value ?? '';

      root.addEventListener('click', async (event) => {
        const save = event.target.closest('[data-save]');
        if (save) {
          const panel = save.dataset.save;
          if (panel === 'workspace') {
            await patch(
              {
                workspaceName: value('#s-workspace'),
                senderName: value('#s-sender'),
                userName: value('#s-user'),
                userRole: value('#s-role'),
                userEmail: value('#s-email'),
                timezone: value('#s-tz'),
              },
              save,
              'Workspace settings saved',
            );
          } else if (panel === 'cover') {
            await patch(
              {
                coverTemplate: selectedTemplate(),
                accent: value('#s-accent'),
                coverHeader: value('#s-header'),
                coverFooter: value('#s-footer'),
                showPageNumbers: root.querySelector('#s-pagenums').checked,
              },
              save,
              'Cover page saved',
            );
            renderPreview();
          } else if (panel === 'notifications') {
            await patch(
              {
                notifyDelivered: root.querySelector('#s-notify-delivered').checked,
                notifyFailed: root.querySelector('#s-notify-failed').checked,
                dailyDigest: root.querySelector('#s-digest').checked,
              },
              save,
              'Notification preferences saved',
            );
          } else if (panel === 'data') {
            await patch({ retentionDays: Number(value('#s-retention')) || 90 }, save, 'Retention updated');
          }
          return;
        }

        const template = event.target.closest('[data-template]');
        if (template) {
          root.querySelectorAll('[data-template]').forEach((button) => button.setAttribute('aria-pressed', String(button === template)));
          renderPreview();
          return;
        }

        const theme = event.target.closest('[data-theme]');
        if (theme) {
          root.querySelectorAll('[data-theme]').forEach((button) => button.setAttribute('aria-pressed', String(button === theme)));
          document.documentElement.dataset.theme = theme.dataset.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme.dataset.theme;
          await patch({ theme: theme.dataset.theme }, null, `Theme set to ${theme.dataset.theme}`);
          return;
        }

        const density = event.target.closest('[data-density]');
        if (density) {
          root.querySelectorAll('[data-density]').forEach((button) => button.setAttribute('aria-pressed', String(button === density)));
          await patch({ density: density.dataset.density }, null, `Density set to ${density.dataset.density}`);
          return;
        }

        if (event.target.closest('[data-action="reset"]')) {
          const confirmed = await confirmDialog({
            title: 'Reset the demo workspace?',
            message: 'Every fax, contact, number, API key and webhook delivery is replaced with the generated sample set.',
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

      function selectedTemplate() {
        return root.querySelector('[data-template][aria-pressed="true"]')?.dataset.template || 'branded';
      }

      const frame = root.querySelector('[data-cover-preview]');
      const renderPreview = debounce(async () => {
        if (!frame) return;
        try {
          const result = await api.post('/api/preview', {
            subject: 'Quarterly compliance packet',
            to: '+1 (212) 555-0110',
            recipientName: 'Priya Raman · Acme Holdings',
            note: 'Attached is the signed packet for your records. Reply on this line if anything needs correcting.',
            cover: {
              accent: /^#[0-9a-fA-F]{6}$/.test(value('#s-accent')) ? value('#s-accent') : '#757cf2',
              coverHeader: value('#s-header'),
              coverFooter: value('#s-footer'),
              showPageNumbers: root.querySelector('#s-pagenums')?.checked !== false,
              senderName: value('#s-sender') || ctx.state.settings?.senderName || '',
            },
          });
          const page = result.pages?.[0];
          frame.innerHTML = page ? page.svg : '<p class="muted">Cover preview unavailable.</p>';
        } catch {
          frame.innerHTML = '<p class="faint" style="font-size:var(--fs-1)">Preview paused — the server rejected the draft.</p>';
        }
      }, 360);

      const accentPicker = root.querySelector('#s-accent-picker');
      accentPicker?.addEventListener('input', () => {
        root.querySelector('#s-accent').value = accentPicker.value;
        renderPreview();
      });
      root.querySelector('#s-accent')?.addEventListener('input', () => {
        const accent = root.querySelector('#s-accent').value;
        if (/^#[0-9a-fA-F]{6}$/.test(accent)) {
          accentPicker.value = accent;
          renderPreview();
        }
      });
      root.querySelector('#s-header')?.addEventListener('input', () => renderPreview());
      root.querySelector('#s-footer')?.addEventListener('input', () => renderPreview());

      renderPreview();
    },
  };
}
