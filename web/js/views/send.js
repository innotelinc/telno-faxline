import { QUALITY, api, debounce, esc, fmt, icon, statusMeta, statusPill } from '../lib.js';

const RATE = { standard: 7, fine: 9, ultra: 12 };

function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function render(ctx) {
  const { state } = ctx;
  const params = new URLSearchParams(window.location.search);
  const prefillTo = params.get('to') || '';
  const prefillName = params.get('name') || '';
  const numbers = state.numbers.filter((number) => number.capabilities.includes('send'));
  const defaultNumberId = state.settings?.defaultNumberId || numbers[0]?.id || '';
  const contacts = state.contacts;
  const defaultSchedule = new Date(Date.now() + 30 * 60000);

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Compose</p>
        <h1 class="page-title">Send a fax</h1>
        <p class="page-sub">Build the cover page, attach documents and pick a delivery window. Everything previews exactly as it will transmit.</p>
      </div>
      <div class="page-head__actions">
        <a class="btn btn--ghost" href="/settings" data-link>${icon('settings', 15)} Cover page design</a>
      </div>
    </header>

    <form class="composer" data-send-form novalidate>
      <div class="composer__form">
        <section class="card card--pad stack">
          <p class="composer__step" data-step="1">Routing</p>
          <div class="composer__row">
            <div class="field">
              <label class="field__label" for="send-from">From number</label>
              <select class="select" id="send-from" name="from">
                ${numbers
                  .map(
                    (number) =>
                      `<option value="${esc(number.id)}"${number.id === defaultNumberId ? ' selected' : ''}>${esc(number.number)} — ${esc(number.label)}</option>`,
                  )
                  .join('')}
              </select>
              <p class="field__hint">Numbers with send capability only.</p>
            </div>
            <div class="field">
              <label class="field__label" for="send-to">Recipient fax number</label>
              <input class="input input--mono" id="send-to" name="to" list="contact-numbers" placeholder="+1 (212) 555-0110"
                value="${esc(prefillTo)}" autocomplete="off" required aria-describedby="send-to-hint" />
              <datalist id="contact-numbers">
                ${contacts.map((contact) => `<option value="${esc(contact.fax)}">${esc(contact.name)} · ${esc(contact.company)}</option>`).join('')}
              </datalist>
              <p class="field__hint" id="send-to-hint">10–15 digits. International numbers accepted with country code.</p>
            </div>
          </div>
          <div class="field">
            <label class="field__label" for="send-name">Recipient name <span>shown on the cover</span></label>
            <input class="input" id="send-name" name="name" list="contact-names" placeholder="Priya Raman · Acme Holdings"
              value="${esc(prefillName)}" autocomplete="off" />
            <datalist id="contact-names">
              ${contacts.map((contact) => `<option value="${esc(`${contact.name} · ${contact.company}`)}">${esc(contact.fax)}</option>`).join('')}
            </datalist>
          </div>
        </section>

        <section class="card card--pad stack">
          <p class="composer__step" data-step="2">Cover page</p>
          <div class="field">
            <label class="field__label" for="send-subject">Subject <span>max 120</span></label>
            <input class="input" id="send-subject" name="subject" maxlength="120" placeholder="Signed NDA — Acme Holdings" />
          </div>
          <div class="field">
            <label class="field__label" for="send-note">Cover message <span>optional</span></label>
            <textarea class="textarea" id="send-note" name="note" maxlength="4000"
              placeholder="Please find the executed agreement attached. Confirm receipt by return fax."></textarea>
            <div class="row row--between">
              <p class="field__hint">Rendered into the cover page and page 2 if it runs long.</p>
              <p class="field__hint mono" data-counter>0 / 4000</p>
            </div>
          </div>
          <div class="field">
            <span class="field__label">Documents <span>PDF or image · up to 10</span></span>
            <input type="file" id="send-files" accept="application/pdf,image/*" multiple hidden />
            <label class="dropzone" for="send-files" data-dropzone tabindex="0" role="button">
              <span>${icon('upload', 18)}</span>
              <span class="dropzone__title">Drop documents here, or browse</span>
              <span class="dropzone__hint">PDF, JPG or PNG · 25 MB total. Files are stored locally and never leave this machine in simulator mode.</span>
            </label>
            <div class="attachment-list" data-attachments></div>
          </div>
        </section>

        <section class="card card--pad stack">
          <p class="composer__step" data-step="3">Delivery options</p>
          <div>
            <span class="field__label" style="margin-bottom:6px;display:block">Resolution</span>
            <div class="option-row" role="group" aria-label="Resolution">
              ${Object.entries(QUALITY)
                .map(
                  ([key, value]) => `<button class="option-card" type="button" data-quality="${key}" aria-pressed="${key === 'standard'}">
                    <span class="option-card__label">${esc(value.label)}</span>
                    <span class="option-card__meta">${esc(value.meta)}</span>
                  </button>`,
                )
                .join('')}
            </div>
          </div>
          <div class="option-grid">
            <div class="field">
              <label class="field__label" for="send-retries">Retry attempts</label>
              <select class="select" id="send-retries">
                ${[1, 2, 3, 4, 5].map((count) => `<option value="${count}"${count === 3 ? ' selected' : ''}>${count} attempt${count === 1 ? '' : 's'}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field__label" for="send-tags">Tags <span>comma separated</span></label>
              <input class="input" id="send-tags" placeholder="legal, quarterly" />
            </div>
          </div>
          <div class="field">
            <label class="switch">
              <input type="checkbox" id="send-schedule-toggle" />
              <span class="switch__track" aria-hidden="true"></span>
              <span>Schedule for later</span>
            </label>
            <div class="field" data-schedule-field hidden style="margin-top:8px">
              <label class="field__label" for="send-schedule">Send at</label>
              <input class="input" type="datetime-local" id="send-schedule" value="${localInputValue(defaultSchedule)}" />
              <p class="field__hint">Telno Faxline releases the fax from the scheduler and keeps retrying inside the next business window.</p>
            </div>
          </div>
          <div class="form-error" data-form-error hidden></div>
        </section>
      </div>

      <aside class="composer__preview" aria-label="Transmission preview">
        <section class="card">
          <div class="card__head">
            <div>
              <h2 class="card__title">Live preview</h2>
              <p class="card__desc" data-preview-label>Cover page renders as you type</p>
            </div>
            <span class="pill pill--muted pill--plain" data-page-count>1 page</span>
          </div>
          <div class="card__body stack">
            <div class="preview-frame" data-preview-frame>
              <div class="skeleton" style="width:100%;aspect-ratio:612/792"></div>
            </div>
            <div class="preview-pages" data-thumbs></div>
            <div class="preview-summary">
              <div class="summary-row"><span>Recipient</span><strong data-sum-recipient>—</strong></div>
              <div class="summary-row"><span>Routing</span><strong data-sum-route>—</strong></div>
              <div class="summary-row"><span>Resolution</span><strong data-sum-quality>Standard</strong></div>
              <div class="summary-row"><span>Estimated cost</span><strong data-sum-cost>$0.07</strong></div>
            </div>
            <button class="btn btn--primary btn--lg btn--block" type="submit" data-submit>
              ${icon('send', 15)} <span data-submit-label>Send fax</span>
            </button>
            <p class="field__hint" style="text-align:center" data-provider-note>${esc(providerNote(state))}</p>
          </div>
        </section>
      </aside>
    </form>`;

  return {
    html,
    mount(root) {
      const form = root.querySelector('[data-send-form]');
      const el = {
        from: root.querySelector('#send-from'),
        to: root.querySelector('#send-to'),
        name: root.querySelector('#send-name'),
        subject: root.querySelector('#send-subject'),
        note: root.querySelector('#send-note'),
        files: root.querySelector('#send-files'),
        dropzone: root.querySelector('[data-dropzone]'),
        attachments: root.querySelector('[data-attachments]'),
        scheduleToggle: root.querySelector('#send-schedule-toggle'),
        scheduleField: root.querySelector('[data-schedule-field]'),
        schedule: root.querySelector('#send-schedule'),
        retries: root.querySelector('#send-retries'),
        tags: root.querySelector('#send-tags'),
        error: root.querySelector('[data-form-error]'),
        frame: root.querySelector('[data-preview-frame]'),
        thumbs: root.querySelector('[data-thumbs]'),
        pageCount: root.querySelector('[data-page-count]'),
        submit: root.querySelector('[data-submit]'),
        submitLabel: root.querySelector('[data-submit-label]'),
        counter: root.querySelector('[data-counter]'),
        sumRecipient: root.querySelector('[data-sum-recipient]'),
        sumRoute: root.querySelector('[data-sum-route]'),
        sumQuality: root.querySelector('[data-sum-quality]'),
        sumCost: root.querySelector('[data-sum-cost]'),
        previewLabel: root.querySelector('[data-preview-label]'),
      };

      let quality = 'standard';
      let documents = [];
      let preview = { pages: [], pageCount: 1, cost: { cents: 7 } };
      let uploading = false;
      let previewSeq = 0;
      let activePage = 0;

      const selectedNumber = () => numbers.find((number) => number.id === el.from.value) || numbers[0];

      function setError(message) {
        el.error.hidden = !message;
        el.error.innerHTML = message ? `${icon('alert', 14)}<span>${esc(message)}</span>` : '';
      }

      function renderAttachments() {
        if (!documents.length) {
          el.attachments.innerHTML = '';
          return;
        }
        el.attachments.innerHTML = documents
          .map(
            (doc, index) => `<div class="attachment">
              <span class="attachment__icon">${icon(doc.kind === 'image' ? 'image' : 'file', 13)}</span>
              <div class="attachment__body">
                <p class="attachment__name truncate">${esc(doc.name)}</p>
                <p class="attachment__meta">${doc.pages} page(s) · ${esc(doc.sizeLabel || fmt.bytes(doc.size || 0))}</p>
              </div>
              <div class="attachment__actions">
                <button class="icon-btn" type="button" data-move="up" data-index="${index}" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${icon('chevronLeft', 13)}</button>
                <button class="icon-btn" type="button" data-move="down" data-index="${index}" aria-label="Move down" ${index === documents.length - 1 ? 'disabled' : ''}>${icon('chevronRight', 13)}</button>
                <button class="icon-btn" type="button" data-remove="${index}" aria-label="Remove attachment">${icon('x', 13)}</button>
              </div>
            </div>`,
          )
          .join('');
      }

      function syncSummary() {
        const number = selectedNumber();
        el.sumRecipient.textContent = el.name.value.trim() || el.to.value.trim() || '—';
        el.sumRoute.textContent = number ? number.number : '—';
        el.sumQuality.textContent = QUALITY[quality].label;
        el.sumCost.textContent = fmt.money((preview.cost?.cents ?? preview.pageCount * RATE[quality]) || 0);
        el.pageCount.textContent = fmt.plural(preview.pageCount, 'page');
      }

      function paintPreview() {
        if (!preview.pages.length) return;
        const page = preview.pages[Math.min(activePage, preview.pages.length - 1)] || preview.pages[0];
        el.frame.innerHTML = page.svg;
        el.thumbs.innerHTML = preview.pages
          .map(
            (item, index) =>
              `<button class="preview-thumb" type="button" data-page="${index}" aria-current="${index === activePage}" aria-label="${esc(item.label)}">
                ${item.svg}
              </button>`,
          )
          .join('');
        el.previewLabel.textContent = page.label;
      }

      const requestPreview = debounce(async () => {
        const seq = ++previewSeq;
        el.frame.setAttribute('aria-busy', 'true');
        try {
          const result = await api.post('/api/preview', {
            from: selectedNumber()?.number || '',
            to: el.to.value,
            recipientName: el.name.value,
            subject: el.subject.value,
            note: el.note.value,
            documentIds: documents.map((doc) => doc.id),
            quality,
          });
          if (seq !== previewSeq) return;
          preview = result;
          if (activePage >= preview.pages.length) activePage = 0;
          paintPreview();
          syncSummary();
        } catch (error) {
          if (seq !== previewSeq) return;
          el.previewLabel.textContent = 'Preview unavailable';
          setError(error.message);
        } finally {
          el.frame.removeAttribute('aria-busy');
        }
      }, 320);

      function validate() {
        const problems = [];
        if (!el.to.value.trim()) problems.push('Recipient fax number is required.');
        else if (el.to.value.replace(/\D/g, '').length < 8) problems.push('Recipient fax number needs at least 8 digits.');
        if (!el.subject.value.trim()) problems.push('Add a subject so the cover page identifies the transmission.');
        if (!numbers.length) problems.push('No sending number is provisioned.');
        if (uploading) problems.push('Wait for the upload to finish.');
        return problems;
      }

      async function uploadFiles(fileList) {
        const files = Array.from(fileList || []).filter((file) => /\.(pdf|jpe?g|png|webp)$/i.test(file.name) || file.type.startsWith('image/') || file.type === 'application/pdf');
        if (!files.length) return;
        if (documents.length + files.length > 10) {
          setError('A fax can include at most 10 documents.');
          return;
        }
        uploading = true;
        el.dropzone.classList.add('is-uploading');
        try {
          const result = await api.upload(files);
          documents = [...documents, ...result.documents];
          renderAttachments();
          requestPreview();
          setError('');
        } catch (error) {
          setError(error.message);
        } finally {
          uploading = false;
          el.dropzone.classList.remove('is-uploading');
          el.files.value = '';
        }
      }

      el.files.addEventListener('change', (event) => uploadFiles(event.target.files));

      ['dragenter', 'dragover'].forEach((type) =>
        el.dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          el.dropzone.classList.add('is-dragover');
        }),
      );
      ['dragleave', 'drop'].forEach((type) =>
        el.dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          el.dropzone.classList.remove('is-dragover');
        }),
      );
      el.dropzone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer?.files));
      el.dropzone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          el.files.click();
        }
      });

      el.attachments.addEventListener('click', (event) => {
        const target = event.target.closest('button');
        if (!target) return;
        if (target.dataset.remove !== undefined) {
          documents.splice(Number(target.dataset.remove), 1);
        } else if (target.dataset.move === 'up') {
          const index = Number(target.dataset.index);
          if (index > 0) [documents[index - 1], documents[index]] = [documents[index], documents[index - 1]];
        } else if (target.dataset.move === 'down') {
          const index = Number(target.dataset.index);
          if (index < documents.length - 1) [documents[index + 1], documents[index]] = [documents[index], documents[index + 1]];
        }
        renderAttachments();
        requestPreview();
      });

      el.thumbs.addEventListener('click', (event) => {
        const target = event.target.closest('[data-page]');
        if (!target) return;
        activePage = Number(target.dataset.page);
        paintPreview();
      });

      root.querySelectorAll('[data-quality]').forEach((button) => {
        button.addEventListener('click', () => {
          quality = button.dataset.quality;
          root.querySelectorAll('[data-quality]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
          requestPreview();
        });
      });

      el.scheduleToggle.addEventListener('change', () => {
        el.scheduleField.hidden = !el.scheduleToggle.checked;
        el.submitLabel.textContent = el.scheduleToggle.checked ? 'Schedule fax' : 'Send fax';
      });

      const contactByFax = (value) => {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 7) return null;
        return state.contacts.find((contact) => {
          const contactDigits = contact.fax.replace(/\D/g, '');
          return contactDigits.endsWith(digits.slice(-7)) || digits.endsWith(contactDigits.slice(-7));
        });
      };

      el.to.addEventListener('input', () => {
        const contact = contactByFax(el.to.value);
        if (contact && !el.name.value.trim()) el.name.value = `${contact.name} · ${contact.company}`;
        syncSummary();
        requestPreview();
      });
      el.name.addEventListener('input', () => {
        const contact = state.contacts.find((item) => el.name.value.trim().toLowerCase() === `${item.name} · ${item.company}`.toLowerCase());
        if (contact) el.to.value = contact.fax;
        syncSummary();
        requestPreview();
      });
      el.subject.addEventListener('input', () => {
        syncSummary();
        requestPreview();
      });
      el.note.addEventListener('input', () => {
        el.counter.textContent = `${el.note.value.length} / 4000`;
        requestPreview();
      });
      el.from.addEventListener('change', () => {
        syncSummary();
        requestPreview();
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const problems = validate();
        if (problems.length) {
          setError(problems[0]);
          el.submit.disabled = false;
          return;
        }
        setError('');
        el.submit.disabled = true;
        el.submitLabel.textContent = 'Sending…';
        el.submit.querySelector('svg')?.replaceWith(Object.assign(document.createElement('span'), { className: 'btn__spinner' }));
        try {
          const payload = {
            fromNumberId: el.from.value,
            to: el.to.value,
            recipientName: el.name.value,
            subject: el.subject.value,
            note: el.note.value,
            documentIds: documents.map((doc) => doc.id),
            quality,
            maxAttempts: Number(el.retries.value),
            tags: el.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
            scheduledAt: el.scheduleToggle.checked && el.schedule.value ? new Date(el.schedule.value).toISOString() : null,
          };
          const { fax } = await api.post('/api/faxes', payload);
          ctx.toast.success(
            fax.status === 'scheduled' ? 'Fax scheduled' : 'Fax queued',
            `${fax.subject} · ${fax.pages} page(s) → ${fax.to_number}`,
          );
          ctx.navigate('/outbox');
          setTimeout(() => ctx.openFax(fax.id), 80);
        } catch (error) {
          setError(error.message);
          ctx.toast.error('Could not send', error.message);
          el.submit.disabled = false;
          el.submitLabel.textContent = el.scheduleToggle.checked ? 'Schedule fax' : 'Send fax';
        }
      });

      syncSummary();
      requestPreview();
      el.to.focus();
    },
  };
}

function providerNote(state) {
  return state.provider?.mode === 'simulated'
    ? 'Simulator mode — no PSTN transmission occurs.'
    : `Live via ${state.provider?.name || 'provider'} · status arrives by webhook.`;
}
