import { api, confirmDialog, debounce, esc, fmt, icon, initials, openModal, toast } from '../lib.js';

export async function render(ctx) {
  const { contacts } = await api.get('/api/contacts');
  const groups = Array.from(new Set(contacts.map((contact) => contact.group_name).filter(Boolean))).sort();
  const local = { query: '', group: 'all', favorites: false };

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Directory</p>
        <h1 class="page-title">Contacts</h1>
        <p class="page-sub">Saved fax destinations with groups, favourites and one-click compose. Contacts power autocomplete in the composer.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--secondary" type="button" data-action="import">${icon('upload', 15)} Import</button>
        <button class="btn btn--primary" type="button" data-action="new">${icon('plus', 15)} New contact</button>
      </div>
    </header>

    <section class="card">
      <div class="filters">
        <div class="search-field">
          ${icon('search', 14)}
          <input class="input" type="search" placeholder="Search name, company or number" aria-label="Search contacts" data-search />
        </div>
        <div class="filters__spacer"></div>
        <button class="chip" type="button" data-favorites aria-pressed="false">${icon('star', 12)} Favourites</button>
        <div class="row row--wrap" style="gap:6px" data-groups>
          <button class="chip" type="button" data-group="all" aria-pressed="true">All <span class="chip--count">${contacts.length}</span></button>
          ${groups
            .map(
              (group) =>
                `<button class="chip" type="button" data-group="${esc(group)}" aria-pressed="false">${esc(group)} <span class="chip--count">${contacts.filter((contact) => contact.group_name === group).length}</span></button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="card__body" data-grid style="padding:var(--space-4) var(--space-5)">
        ${gridHtml(contacts)}
      </div>
    </section>`;

  return {
    html,
    mount(root) {
      const grid = root.querySelector('[data-grid]');
      const search = root.querySelector('[data-search]');
      const favoriteButton = root.querySelector('[data-favorites]');

      const paint = () => {
        const query = local.query.trim().toLowerCase();
        const list = contacts.filter((contact) => {
          if (local.favorites && !contact.favorite) return false;
          if (local.group !== 'all' && contact.group_name !== local.group) return false;
          if (!query) return true;
          return [contact.name, contact.company, contact.fax, contact.email, contact.group_name]
            .join(' ')
            .toLowerCase()
            .includes(query);
        });
        grid.innerHTML = list.length
          ? gridHtml(list)
          : `<div class="empty"><div class="empty__icon">${icon('contacts', 18)}</div>
             <p class="empty__title">No contacts match</p>
             <p class="empty__text">Clear the filters, or add a destination to get started.</p></div>`;
      };

      search.addEventListener('input', debounce(() => {
        local.query = search.value;
        paint();
      }, 160));

      root.querySelectorAll('[data-group]').forEach((button) => {
        button.addEventListener('click', () => {
          local.group = button.dataset.group;
          root.querySelectorAll('[data-group]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
          paint();
        });
      });

      favoriteButton.addEventListener('click', () => {
        local.favorites = !local.favorites;
        favoriteButton.setAttribute('aria-pressed', String(local.favorites));
        paint();
      });

      const afterChange = async (message) => {
        toast.success(message);
        await ctx.reload();
      };

      const openEditor = (contact = null) => {
        const isEdit = Boolean(contact);
        const modal = openModal({
          title: isEdit ? 'Edit contact' : 'New contact',
          sub: isEdit ? contact.fax : 'Contacts are reused across the composer and API.',
          body: `<div class="form-grid">
            <div class="field span-2"><label class="field__label" for="c-name">Name</label>
              <input class="input" id="c-name" value="${esc(contact?.name || '')}" autofocus /></div>
            <div class="field"><label class="field__label" for="c-company">Company</label>
              <input class="input" id="c-company" value="${esc(contact?.company || '')}" /></div>
            <div class="field"><label class="field__label" for="c-fax">Fax number</label>
              <input class="input input--mono" id="c-fax" value="${esc(contact?.fax || '')}" placeholder="+1 (212) 555-0110" /></div>
            <div class="field"><label class="field__label" for="c-email">Email <span>optional</span></label>
              <input class="input" id="c-email" type="email" value="${esc(contact?.email || '')}" /></div>
            <div class="field"><label class="field__label" for="c-group">Group</label>
              <input class="input" id="c-group" list="c-groups" value="${esc(contact?.group_name || 'General')}" />
              <datalist id="c-groups">${groups.map((group) => `<option value="${esc(group)}"></option>`).join('')}</datalist></div>
            <div class="field span-2"><label class="field__label" for="c-notes">Notes <span>optional</span></label>
              <textarea class="textarea" id="c-notes" style="min-height:70px">${esc(contact?.notes || '')}</textarea></div>
            <label class="check span-2"><input type="checkbox" id="c-fav" ${contact?.favorite ? 'checked' : ''} /> <span>Mark as favourite</span></label>
          </div>
          <div class="form-error" data-error hidden></div>`,
          footer: `<button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
            <button class="btn btn--primary" type="button" data-save>${isEdit ? 'Save changes' : 'Add contact'}</button>`,
        });

        const error = modal.el.querySelector('[data-error]');
        modal.foot.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
        modal.foot.querySelector('[data-save]').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const payload = {
            name: modal.el.querySelector('#c-name').value.trim(),
            company: modal.el.querySelector('#c-company').value.trim(),
            fax: modal.el.querySelector('#c-fax').value.trim(),
            email: modal.el.querySelector('#c-email').value.trim(),
            group: modal.el.querySelector('#c-group').value.trim() || 'General',
            notes: modal.el.querySelector('#c-notes').value.trim(),
            favorite: modal.el.querySelector('#c-fav').checked,
          };
          if (!payload.name || !payload.fax) {
            error.hidden = false;
            error.textContent = 'Name and fax number are required.';
            return;
          }
          button.disabled = true;
          try {
            if (isEdit) await api.patch(`/api/contacts/${contact.id}`, payload);
            else await api.post('/api/contacts', payload);
            modal.close();
            await afterChange(isEdit ? 'Contact updated' : 'Contact added');
          } catch (requestError) {
            error.hidden = false;
            error.textContent = requestError.message;
            button.disabled = false;
          }
        });
      };

      grid.addEventListener('click', async (event) => {
        const star = event.target.closest('[data-favorite]');
        const edit = event.target.closest('[data-edit]');
        const remove = event.target.closest('[data-delete]');
        if (star) {
          const contact = contacts.find((item) => item.id === star.dataset.favorite);
          try {
            await api.patch(`/api/contacts/${contact.id}`, { favorite: !contact.favorite });
            toast.success(contact.favorite ? 'Removed from favourites' : 'Added to favourites');
            await ctx.reload();
          } catch (error) {
            toast.error('Could not update favourite', error.message);
          }
          return;
        }
        if (edit) {
          openEditor(contacts.find((item) => item.id === edit.dataset.edit));
          return;
        }
        if (remove) {
          const contact = contacts.find((item) => item.id === remove.dataset.delete);
          const confirmed = await confirmDialog({
            title: 'Delete contact?',
            message: `${contact?.name} will be removed from the directory. Existing faxes are not affected.`,
            confirmLabel: 'Delete contact',
          });
          if (!confirmed) return;
          try {
            await api.del(`/api/contacts/${contact.id}`);
            await afterChange('Contact deleted');
          } catch (error) {
            toast.error('Delete failed', error.message);
          }
        }
      });

      root.querySelector('[data-action="new"]').addEventListener('click', () => openEditor());
      root.querySelector('[data-action="import"]').addEventListener('click', () => openImport(ctx));
    },
  };
}

function gridHtml(contacts) {
  return `<div class="contact-grid">${contacts
    .map(
      (contact) => `<article class="contact-card">
        <div class="contact-card__head">
          <span class="avatar avatar--square">${esc(initials(contact.name))}</span>
          <div class="grow">
            <p class="contact-card__name truncate">${esc(contact.name)}</p>
            <p class="contact-card__company truncate">${esc(contact.company || 'Independent')}</p>
          </div>
          <button class="star-btn" type="button" data-favorite="${esc(contact.id)}" aria-pressed="${Boolean(contact.favorite)}" aria-label="${contact.favorite ? 'Remove favourite' : 'Mark favourite'}">
            ${icon('star', 15)}
          </button>
        </div>
        <span class="contact-card__fax">${icon('printer', 12)} ${esc(contact.fax)}</span>
        <div class="row row--between">
          <span class="tag">${esc(contact.group_name || 'General')}</span>
          <span class="faint" style="font-size:var(--fs-1)">${contact.last_fax_at ? `Last fax ${esc(fmt.relative(contact.last_fax_at))}` : 'No faxes yet'}</span>
        </div>
        <div class="contact-card__foot">
          <a class="btn btn--secondary btn--sm" href="/send?to=${encodeURIComponent(contact.fax)}&name=${encodeURIComponent(`${contact.name} · ${contact.company}`)}" data-link>${icon('send', 12)} Send fax</a>
          <div class="row" style="gap:2px">
            <button class="icon-btn" type="button" data-edit="${esc(contact.id)}" aria-label="Edit ${esc(contact.name)}">${icon('settings', 13)}</button>
            <button class="icon-btn" type="button" data-delete="${esc(contact.id)}" aria-label="Delete ${esc(contact.name)}">${icon('trash', 13)}</button>
          </div>
        </div>
      </article>`,
    )
    .join('')}</div>`;
}

function openImport(ctx) {
  const modal = openModal({
    title: 'Import contacts',
    sub: 'One contact per line: name, company, fax number, email, group',
    body: `<div class="field">
        <label class="field__label" for="import-data">Paste rows</label>
        <textarea class="textarea" id="import-data" style="min-height:180px" placeholder="Priya Raman, Acme Holdings, +1 212 555 0110, priya@acme.com, Legal
Marcus Webb, Northwind Labs, +1 415 555 0177, m.webb@northwind.io, Clients"></textarea>
        <p class="field__hint">Commas or tabs both work. Fax number is required; everything else is optional.</p>
      </div>
      <div class="form-error" data-error hidden></div>
      <div class="inline-note">Existing numbers are kept as-is — duplicates are created rather than merged, so review the list afterwards.</div>`,
    footer: `<button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
      <button class="btn btn--primary" type="button" data-import>Import contacts</button>`,
  });

  modal.foot.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  modal.foot.querySelector('[data-import]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const error = modal.el.querySelector('[data-error]');
    const rows = modal.el
      .querySelector('#import-data')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!rows.length) {
      error.hidden = false;
      error.textContent = 'Paste at least one row.';
      return;
    }
    button.disabled = true;
    let imported = 0;
    const failures = [];
    for (const row of rows) {
      const [name, company, fax, email, group] = row.split(/\t|,/).map((part) => part.trim());
      if (!name || !fax) {
        failures.push(row);
        continue;
      }
      try {
        await api.post('/api/contacts', { name, company, fax, email, group });
        imported += 1;
      } catch {
        failures.push(row);
      }
    }
    modal.close();
    toast.success(`${imported} contact${imported === 1 ? '' : 's'} imported`, failures.length ? `${failures.length} row(s) skipped.` : '');
    await ctx.reload();
  });
}
