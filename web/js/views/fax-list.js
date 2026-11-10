import { api, confirmDialog, debounce, esc, fmt, icon, statusMeta, statusPill } from '../lib.js';

/**
 * Shared outbox/inbox surface: tabbed status filters, instant client-side
 * search over the loaded window, and row actions that stay in sync live.
 */
export async function renderFaxList(ctx, config) {
  const { state } = ctx;
  const inbound = config.direction === 'in';
  const { items } = await api.get(`/api/faxes?direction=${config.direction}&limit=100&sort=newest`);
  const local = { tab: config.tabs[0].key, query: '', sort: 'newest' };

  const countFor = (tab) => items.filter(tab.match).length;

  const rowsHtml = (faxes) => {
    if (!faxes.length) {
      return `<tr><td colspan="7">${emptyBlock(config, local)}</td></tr>`;
    }
    return faxes
      .map((fax) => {
        const meta = statusMeta(fax.status);
        const counterpart = inbound ? fax.recipient_name : fax.recipient_name;
        const number = inbound ? fax.from_number : fax.to_number;
        return `<tr data-clickable="true" data-fax="${esc(fax.id)}" tabindex="0" class="${!inbound && !fax.read ? 'fax-row--unread' : ''}">
          <td>
            <div class="cell-main">
              ${inbound && !fax.read ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}
              <span class="dir-icon ${fax.status === 'failed' ? 'dir-icon--fail' : inbound ? '' : 'dir-icon--out'}">${icon(fax.status === 'failed' ? 'alert' : inbound ? 'inbox' : 'send', 13)}</span>
              <div class="cell-main__text">
                <span class="cell-title">${esc(fax.subject || 'Untitled fax')}</span>
                <span class="cell-sub">${esc(counterpart || '—')}</span>
              </div>
            </div>
          </td>
          <td class="hide-sm"><span class="num">${esc(number)}</span></td>
          <td>${statusPill(fax.status)}</td>
          <td class="num">${fax.pages}</td>
          <td class="num hide-sm">${esc(fmt.relative(fax.created_at))}</td>
          <td class="num">${fax.cost_cents ? esc(fmt.money(fax.cost_cents)) : '—'}</td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" type="button" data-star="${esc(fax.id)}" aria-label="${fax.starred ? 'Unstar' : 'Star'}" aria-pressed="${Boolean(fax.starred)}" title="${fax.starred ? 'Unstar' : 'Star'}">
                ${icon('star', 14)}
              </button>
              <a class="icon-btn" href="/api/faxes/${encodeURIComponent(fax.id)}/pdf" download aria-label="Download PDF" title="Download PDF">${icon('download', 14)}</a>
              <button class="icon-btn" type="button" data-delete="${esc(fax.id)}" aria-label="Delete fax" title="Delete">${icon('trash', 14)}</button>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  };

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">${esc(config.eyebrow)}</p>
        <h1 class="page-title">${esc(config.title)}</h1>
        <p class="page-sub">${esc(config.sub)}</p>
      </div>
      <div class="page-head__actions">${config.actionsHtml || ''}</div>
    </header>

    <section class="card">
      <div class="tabs" role="tablist" aria-label="Filter faxes" data-tabs>
        ${config.tabs
          .map(
            (tab) => `<button class="tab" type="button" role="tab" data-tab="${esc(tab.key)}" aria-selected="${tab.key === local.tab}">
              ${esc(tab.label)}<span class="tab__count" data-count="${esc(tab.key)}">${countFor(tab)}</span>
            </button>`,
          )
          .join('')}
      </div>
      <div class="filters">
        <div class="search-field">
          ${icon('search', 14)}
          <input class="input" type="search" placeholder="Search subject, recipient or number" aria-label="Search faxes" data-search />
        </div>
        <div class="filters__spacer"></div>
        <label class="sr-only" for="sort-faxes">Sort</label>
        <select class="select" id="sort-faxes" data-sort>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="pages">Most pages</option>
        </select>
        <button class="btn btn--secondary btn--sm" type="button" data-refresh>${icon('refresh', 13)} Refresh</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>${inbound ? 'Received' : 'Transmission'}</th>
              <th class="hide-sm">Number</th>
              <th>Status</th>
              <th>Pages</th>
              <th class="hide-sm">When</th>
              <th>Cost</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody data-rows>${rowsHtml(items)}</tbody>
        </table>
      </div>
      <div class="pagination">
        <span data-summary>${fmt.plural(items.length, 'fax')}</span>
        <span class="faint">Live updates enabled</span>
      </div>
    </section>`;

  return {
    html,
    mount(root) {
      const tbody = root.querySelector('[data-rows]');
      const summary = root.querySelector('[data-summary]');
      const search = root.querySelector('[data-search]');
      const sort = root.querySelector('[data-sort]');

      const filtered = () => {
        const query = local.query.trim().toLowerCase();
        const tab = config.tabs.find((item) => item.key === local.tab) || config.tabs[0];
        let list = items.filter(tab.match);
        if (query) {
          list = list.filter((fax) =>
            [fax.subject, fax.recipient_name, fax.to_number, fax.from_number]
              .join(' ')
              .toLowerCase()
              .includes(query),
          );
        }
        list.sort((a, b) => {
          if (local.sort === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
          if (local.sort === 'pages') return b.pages - a.pages;
          return new Date(b.created_at) - new Date(a.created_at);
        });
        return list;
      };

      const paint = () => {
        const list = filtered();
        tbody.innerHTML = rowsHtml(list);
        summary.textContent = `${fmt.plural(list.length, 'fax')} shown · ${fmt.plural(items.length, 'loaded')}`;
      };

      root.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          local.tab = button.dataset.tab;
          root.querySelectorAll('[data-tab]').forEach((item) => item.setAttribute('aria-selected', String(item === button)));
          paint();
        });
      });

      search.addEventListener(
        'input',
        debounce(() => {
          local.query = search.value;
          paint();
        }, 180),
      );
      sort.addEventListener('change', () => {
        local.sort = sort.value;
        paint();
      });

      root.querySelector('[data-refresh]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const fresh = await api.get(`/api/faxes?direction=${config.direction}&limit=100&sort=newest`);
          items.length = 0;
          items.push(...fresh.items);
          config.tabs.forEach((tab) => {
            const badge = root.querySelector(`[data-count="${tab.key}"]`);
            if (badge) badge.textContent = countFor(tab);
          });
          paint();
          ctx.toast.info('Fax list refreshed');
        } catch (error) {
          ctx.toast.error('Refresh failed', error.message);
        } finally {
          button.disabled = false;
        }
      });

      tbody.addEventListener('click', async (event) => {
        const starButton = event.target.closest('[data-star]');
        const deleteButton = event.target.closest('[data-delete]');
        const row = event.target.closest('[data-fax]');
        if (starButton) {
          event.stopPropagation();
          const fax = items.find((item) => item.id === starButton.dataset.star);
          try {
            const { fax: updated } = await api.post(`/api/faxes/${starButton.dataset.star}/star`, { starred: !fax?.starred });
            Object.assign(fax || {}, updated);
            starButton.setAttribute('aria-pressed', String(Boolean(updated.starred)));
            starButton.innerHTML = icon('star', 14);
            starButton.style.color = updated.starred ? 'var(--warning)' : '';
            paint();
          } catch (error) {
            ctx.toast.error('Could not update star', error.message);
          }
          return;
        }
        if (deleteButton) {
          event.stopPropagation();
          const fax = items.find((item) => item.id === deleteButton.dataset.delete);
          const confirmed = await confirmDialog({
            title: 'Delete this fax?',
            message: `“${fax?.subject || 'Untitled fax'}” and its rendered pages will be removed from the workspace. This cannot be undone.`,
            confirmLabel: 'Delete fax',
          });
          if (!confirmed) return;
          try {
            await api.del(`/api/faxes/${deleteButton.dataset.delete}`);
            const index = items.findIndex((item) => item.id === deleteButton.dataset.delete);
            if (index !== -1) items.splice(index, 1);
            ctx.toast.success('Fax deleted');
            paint();
          } catch (error) {
            ctx.toast.error('Delete failed', error.message);
          }
          return;
        }
        if (row) ctx.openFax(row.dataset.fax);
      });

      tbody.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('[data-fax]');
        if (!row) return;
        event.preventDefault();
        ctx.openFax(row.dataset.fax);
      });
    },
  };
}

function emptyBlock(config, local) {
  return `<div class="empty" style="border:0;background:none;padding:44px 20px">
    <div class="empty__icon">${icon(config.direction === 'in' ? 'inbox' : 'send', 18)}</div>
    <p class="empty__title">${esc(local.query ? 'No faxes match that search' : config.emptyTitle)}</p>
    <p class="empty__text">${esc(local.query ? 'Try a different subject, recipient or number.' : config.emptyText)}</p>
  </div>`;
}
