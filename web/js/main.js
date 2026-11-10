import {
  $,
  $$,
  api,
  bindActions,
  closeTopOverlay,
  copyText,
  debounce,
  esc,
  fmt,
  icon,
  initials,
  on,
  openDrawer,
  openModal,
  statusMeta,
  statusPill,
  toast,
} from './lib.js';

/* -------------------------------------------------------------------- state */

const state = {
  settings: null,
  numbers: [],
  contacts: [],
  faxes: [],
  stats: null,
  events: [],
  deliveries: [],
  provider: null,
  counts: { unread: 0, queued: 0, failed: 0, scheduled: 0 },
  engine: null,
  route: '/overview',
  range: 30,
  ui: { nav: 'closed', ready: false },
  faxListener: null,
};

const ROUTES = {
  '/overview': { file: 'overview', title: 'Overview', navKey: 'overview' },
  '/send': { file: 'send', title: 'Send fax', navKey: 'send' },
  '/outbox': { file: 'outbox', title: 'Outbox', navKey: 'outbox' },
  '/inbox': { file: 'inbox', title: 'Inbox', navKey: 'inbox' },
  '/contacts': { file: 'contacts', title: 'Contacts', navKey: 'contacts' },
  '/numbers': { file: 'numbers', title: 'Numbers', navKey: 'numbers' },
  '/analytics': { file: 'analytics', title: 'Analytics', navKey: 'analytics' },
  '/developer': { file: 'developer', title: 'Developer', navKey: 'developer' },
  '/settings': { file: 'settings', title: 'Settings', navKey: 'settings' },
};

const NAV_GROUPS = [
  {
    label: 'Fax operations',
    items: [
      { key: 'overview', path: '/overview', label: 'Overview', icon: 'overview' },
      { key: 'send', path: '/send', label: 'Send fax', icon: 'send' },
      { key: 'outbox', path: '/outbox', label: 'Outbox', icon: 'outbox', badge: 'queued' },
      { key: 'inbox', path: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'unread' },
    ],
  },
  {
    label: 'Directory',
    items: [
      { key: 'contacts', path: '/contacts', label: 'Contacts', icon: 'contacts' },
      { key: 'numbers', path: '/numbers', label: 'Numbers', icon: 'numbers' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { key: 'analytics', path: '/analytics', label: 'Analytics', icon: 'analytics' },
      { key: 'developer', path: '/developer', label: 'Developer', icon: 'developer' },
      { key: 'settings', path: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

let viewRoot = null;
let renderToken = 0;
let currentTeardown = null;

/* -------------------------------------------------------------------- shell */

function sidebarHtml() {
  const groups = NAV_GROUPS.map((group) => {
    const items = group.items
      .map((item) => {
        const badgeValue = item.badge ? state.counts[item.badge] : 0;
        const badge = badgeValue
          ? `<span class="nav__badge ${item.badge === 'failed' ? 'nav__badge--danger' : ''}">${badgeValue}</span>`
          : '';
        const active = state.route === item.path;
        return `<a class="nav__item" href="${item.path}" data-link${active ? ' aria-current="page"' : ''}>
            ${icon(item.icon, 16)}<span>${esc(item.label)}</span>${badge}
          </a>`;
      })
      .join('');
    return `<div class="nav__group"><p class="nav__label">${esc(group.label)}</p>${items}</div>`;
  }).join('');

  const provider = state.provider;
  const planTitle = provider?.mode === 'simulated' ? 'Simulator mode' : `${provider?.name ?? 'Provider'} connected`;
  const planText =
    provider?.mode === 'simulated'
      ? 'Every fax is rendered and simulated locally. Add provider keys to go live.'
      : 'Live transmissions are handled by your configured provider.';

  return `
    <div class="nav">${groups}</div>
    <div class="sidebar__foot">
      <div class="plan-card">
        <p class="plan-card__title">${esc(planTitle)}</p>
        <p class="plan-card__text">${esc(planText)}</p>
        <div class="meter" role="presentation"><div class="meter__fill" style="width:${provider?.mode === 'simulated' ? 34 : 82}%"></div></div>
        <a class="section-link" href="/developer" data-link>Provider settings ${icon('arrowRight', 12)}</a>
      </div>
      <div class="sidebar__links">
        <a href="/developer" data-link>API</a><span aria-hidden="true">·</span>
        <a href="/settings" data-link>Docs</a>
      </div>
      <div class="sidebar__status">
        <span class="status-dot ${provider?.mode === 'simulated' ? 'status-dot--warn' : ''}"></span>
        ${provider?.mode === 'simulated' ? 'Local simulator' : esc(provider?.name || 'Provider')}
        <span class="faint">· v1.0</span>
      </div>
    </div>`;
}

function topbarHtml() {
  const settings = state.settings || {};
  const provider = state.provider;
  return `
    <header class="topbar">
      <button class="icon-btn hide-sm" data-action="toggle-nav" aria-label="Toggle sidebar" aria-expanded="false" aria-controls="sidebar">${icon('menu', 18)}</button>
      <a class="brand" href="/overview" data-link aria-label="Faxline home">
        <span class="brand__mark">${icon('printer', 16)}</span>
        <span class="brand__name">Faxline</span>
      </a>
      <button class="ws-switch" data-action="open-palette" title="Switch workspace or search">
        <span class="ws-switch__dot"></span>
        <span class="ws-switch__text truncate">${esc(settings.workspaceName || 'Workspace')}</span>
        ${icon('chevronDown', 12)}
      </button>
      ${provider?.mode === 'simulated'
        ? `<span class="demo-pill" title="No provider keys detected: transmissions are simulated"><span class="demo-pill__pulse"></span><span class="demo-pill__label">Simulator</span></span>`
        : `<span class="demo-pill" title="Live provider active"><span class="demo-pill__pulse"></span><span class="demo-pill__label">Live</span></span>`}
      <div class="topbar__spacer"></div>
      <button class="search-trigger" data-action="open-palette" aria-label="Search workspace">
        ${icon('search', 14)}<span>Search workspace…</span><kbd>⌘K</kbd>
      </button>
      <button class="icon-btn icon-btn--bordered" data-action="cycle-theme" aria-label="Change theme" title="Change theme">
        ${icon(settings.theme === 'dark' ? 'moon' : 'sun', 16)}
      </button>
      <button class="account" data-action="open-account" aria-label="${esc(settings.userName || 'Account')} account menu">
        <span class="account__avatar">${esc(initials(settings.userName || 'Faxline'))}</span>
      </button>
    </header>`;
}

function buildShell() {
  const app = $('#app');
  app.innerHTML = `${topbarHtml()}
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Workspace sidebar"><div id="sidebar-inner" style="display:contents">${sidebarHtml()}</div></aside>
      <main id="main-view" class="main" tabindex="-1"></main>
    </div>`;
  viewRoot = $('#main-view');
  app.hidden = false;
  $('#boot')?.remove();
}

function refreshChrome() {
  const inner = $('#sidebar-inner');
  if (inner) inner.innerHTML = sidebarHtml();
  const top = $('.topbar');
  if (top) {
    const settings = state.settings || {};
    const wsText = top.querySelector('.ws-switch__text');
    if (wsText) wsText.textContent = settings.workspaceName || 'Workspace';
    const themeBtn = top.querySelector('[data-action="cycle-theme"]');
    if (themeBtn) themeBtn.innerHTML = icon(settings.theme === 'dark' ? 'moon' : 'sun', 16);
    const avatar = top.querySelector('.account__avatar');
    if (avatar) avatar.textContent = initials(settings.userName || 'Faxline');
  }
}

/* -------------------------------------------------------------------- theme */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const preferred = state.settings?.theme || 'system';
  const resolved = preferred === 'system' ? (media.matches ? 'dark' : 'light') : preferred;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.density = state.settings?.density || 'comfortable';
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
}
media.addEventListener('change', () => {
  if ((state.settings?.theme || 'system') === 'system') applyTheme();
});

async function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const current = state.settings?.theme || 'system';
  const next = order[(order.indexOf(current) + 1) % order.length];
  state.settings = { ...state.settings, theme: next };
  applyTheme();
  toast.info(`Theme: ${next === 'system' ? 'follow system' : next}`);
  try {
    const result = await api.patch('/api/settings', { theme: next });
    state.settings = result.settings;
  } catch {
    /* theme is cosmetic; keep the local preference */
  }
}

/* ------------------------------------------------------------------- router */

export function navigate(path, { replace = false } = {}) {
  const url = new URL(path, window.location.origin);
  const next = url.pathname;
  const route = ROUTES[next] ? next : '/overview';
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  state.route = route;
  state.ui.nav = 'closed';
  $('#app')?.setAttribute('data-nav', 'closed');
  renderRoute();
}

function routeFromLocation() {
  const path = window.location.pathname;
  return ROUTES[path] ? path : '/overview';
}

function viewContext() {
  return {
    state,
    navigate,
    reload: async () => {
      await loadBootstrap();
      await renderRoute();
    },
    refreshStats: async (range = state.range) => {
      state.range = range;
      state.stats = await api.get(`/api/stats?range=${range}`);
      return state.stats;
    },
    openFax,
    toast,
    copyText,
  };
}

async function renderRoute() {
  if (!viewRoot) return;
  const token = ++renderToken;
  const route = ROUTES[state.route] || ROUTES['/overview'];
  document.title = `${route.title} — Faxline`;
  if (currentTeardown) {
    try {
      currentTeardown();
    } catch {
      /* ignore teardown errors */
    }
    currentTeardown = null;
  }
  viewRoot.setAttribute('aria-busy', 'true');
  viewRoot.innerHTML = skeletonHtml();
  refreshChrome();

  try {
    const module = await import(`./views/${route.file}.js`);
    if (token !== renderToken) return;
    const result = await module.render(viewContext());
    if (token !== renderToken) return;
    viewRoot.innerHTML = result.html;
    viewRoot.setAttribute('aria-busy', 'false');
    result.mount?.(viewRoot);
    currentTeardown = result.teardown || null;
    viewRoot.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  } catch (error) {
    if (token !== renderToken) return;
    console.error('[faxline] view failed', error);
    viewRoot.setAttribute('aria-busy', 'false');
    viewRoot.innerHTML = `
      <div class="page-head"><div class="page-head__text">
        <p class="eyebrow">Something broke</p>
        <h1 class="page-title">${esc(route.title)} could not load</h1>
        <p class="page-sub">${esc(error?.message || 'Unexpected client error.')}</p>
      </div></div>
      <div class="empty">
        <div class="empty__icon">${icon('alert', 18)}</div>
        <p class="empty__title">The view hit an error</p>
        <p class="empty__text">Reload the workspace data, or open the browser console for the full stack trace.</p>
        <button class="btn btn--primary" type="button" data-action="retry-view">Try again</button>
      </div>`;
    bindActions(viewRoot, {
      'retry-view': async () => {
        await loadBootstrap();
        renderRoute();
      },
    });
  }
}

function skeletonHtml() {
  return `
    <div class="page-head"><div class="page-head__text">
      <div class="skeleton" style="width:88px;height:10px"></div>
      <div class="skeleton" style="width:220px;height:26px"></div>
      <div class="skeleton" style="width:min(520px,70vw);height:12px"></div>
    </div></div>
    <div class="kpi-grid">
      ${Array.from({ length: 4 })
        .map(
          () => `<div class="kpi"><div class="skeleton" style="width:70%;height:10px"></div>
        <div class="skeleton" style="width:52%;height:24px;margin-top:12px"></div>
        <div class="skeleton" style="width:40%;height:9px;margin-top:auto"></div></div>`,
        )
        .join('')}
    </div>
    <div class="card"><div class="card__body"><div class="skeleton" style="width:100%;height:220px"></div></div></div>`;
}

/* ---------------------------------------------------------------- data load */

async function loadBootstrap() {
  const data = await api.get('/api/bootstrap');
  state.settings = data.settings;
  state.numbers = data.numbers;
  state.contacts = data.contacts;
  state.faxes = data.faxes;
  state.stats = data.stats;
  state.events = data.events;
  state.deliveries = data.deliveries;
  state.provider = data.provider;
  state.engine = data.engine;
  state.counts = data.counts;
  state.range = data.stats?.days || 30;
  applyTheme();
  return data;
}

function upsertFax(fax) {
  if (!fax?.id) return;
  const index = state.faxes.findIndex((item) => item.id === fax.id);
  if (index === -1) state.faxes.unshift(fax);
  else state.faxes[index] = { ...state.faxes[index], ...fax };
  state.faxes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  state.faxes = state.faxes.slice(0, 40);
}

const refreshStatsSoon = debounce(async (redraw = true) => {
  try {
    state.stats = await api.get(`/api/stats?range=${state.range}`);
    const counts = await api.get('/api/bootstrap');
    state.counts = counts.counts;
    refreshChrome();
    if (redraw && ['/overview', '/analytics', '/outbox', '/inbox'].includes(state.route)) renderRoute();
  } catch {
    /* a stale stat is harmless */
  }
}, 700);

/* ---------------------------------------------------------------------- SSE */

function connectStream() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/stream');
  source.addEventListener('fax.updated', (event) => {
    const data = safeParse(event.data);
    if (!data?.fax) return;
    upsertFax(data.fax);
    state.faxListener?.(data.fax);
  });
  for (const name of ['fax.created', 'fax.received', 'fax.delivered', 'fax.failed']) {
    source.addEventListener(name, (event) => {
      const data = safeParse(event.data);
      if (!data?.fax) return;
      upsertFax(data.fax);
      state.faxListener?.(data.fax);
      if (name === 'fax.delivered') {
        toast.success('Fax delivered', `${data.fax.subject || 'Transmission'} · ${data.fax.to_number}`);
      } else if (name === 'fax.failed') {
        toast.error('Transmission failed', data.fax.error_message || data.fax.subject || 'Provider reported a failure.');
      } else if (name === 'fax.received') {
        toast.info('Inbound fax received', `${data.fax.recipient_name} · ${fmt.plural(data.fax.pages, 'page')}`);
      }
      refreshStatsSoon(!document.querySelector('.drawer'));
    });
  }
  source.addEventListener('counts.stale', () => refreshStatsSoon(false));
  source.addEventListener('stats.stale', () => refreshStatsSoon(!document.querySelector('.drawer')));
  source.addEventListener('workspace.reset', () => {
    toast.info('Demo workspace reset', 'Reloading fresh sample data.');
    setTimeout(() => window.location.reload(), 400);
  });
  source.addEventListener('settings.updated', (event) => {
    const data = safeParse(event.data);
    if (data?.settings) {
      state.settings = data.settings;
      applyTheme();
      refreshChrome();
    }
  });
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) setTimeout(connectStream, 4000);
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- fax detail */

export async function openFax(id) {
  let handle = null;
  const body = `<div class="stack" aria-busy="true"><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:180px"></div></div>`;
  handle = openDrawer({
    title: 'Loading fax…',
    body,
    onClose: () => {
      state.faxListener = null;
    },
  });

  const paint = async () => {
    const { fax } = await api.get(`/api/faxes/${id}`);
    const render = fax.render || { pages: [] };
    const meta = statusMeta(fax.status);
    handle.el.querySelector('.drawer__title').textContent = fax.subject || 'Untitled fax';
    handle.sub.innerHTML = `<div class="row row--wrap" style="gap:8px">
        ${statusPill(fax.status)}
        <span class="faint mono" style="font-size:10.5px">${esc(fax.direction === 'in' ? 'Inbound' : 'Outbound')} · ${fmt.plural(fax.pages, 'page')}</span>
      </div>`;
    const isInbound = fax.direction === 'in';
    handle.setBody(`
      <div class="detail-meta">
        <div class="detail-meta__item"><span class="detail-meta__label">${isInbound ? 'From' : 'To'}</span>
          <span class="detail-meta__value">${esc(isInbound ? fax.from_number : fax.recipient_name || 'Recipient')}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Fax number</span>
          <span class="detail-meta__value detail-meta__value--mono">${esc(isInbound ? fax.from_number : fax.to_number)}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">${isInbound ? 'Received on' : 'Sent from'}</span>
          <span class="detail-meta__value detail-meta__value--mono">${esc(isInbound ? fax.to_number : fax.from_number)}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Pages</span>
          <span class="detail-meta__value">${fmt.plural(fax.pages, 'page')} · ${esc(fax.quality)}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Created</span>
          <span class="detail-meta__value">${esc(fmt.dateTime(fax.created_at))}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">${fax.status === 'delivered' ? 'Duration' : 'Cost'}</span>
          <span class="detail-meta__value">${fax.status === 'delivered' ? esc(fmt.duration(fax.duration_sec)) : esc(fmt.money(fax.cost_cents))}</span></div>
      </div>
      ${fax.error_message ? `<div class="error-box"><span class="error-box__code">${esc(fax.error_code || 'ERROR')}</span><span class="error-box__msg">${esc(fax.error_message)}</span></div>` : ''}
      ${fax.note ? `<div><p class="eyebrow" style="margin-bottom:6px">Cover message</p><p style="font-size:var(--fs-2);color:var(--muted);line-height:1.6">${esc(fax.note)}</p></div>` : ''}
      <div>
        <div class="row row--between" style="margin-bottom:8px">
          <p class="eyebrow">Pages</p>
          <a class="section-link" href="/api/faxes/${encodeURIComponent(fax.id)}/pdf" download>Download PDF ${icon('download', 12)}</a>
        </div>
        <div class="page-strip">
          ${(render.pages || [])
            .map(
              (page, index) => `<button class="page-thumb" type="button" data-page="${index}" aria-current="${index === 0}" aria-label="Preview page ${index + 1}">
                <img src="/api/faxes/${encodeURIComponent(fax.id)}/page/${index}.svg" alt="" width="96" height="124" loading="lazy" />
                <span>${esc(page.label || `Page ${index + 1}`)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>
      <div>
        <p class="eyebrow" style="margin-bottom:10px">Delivery timeline</p>
        <div class="timeline">
          ${(fax.timeline || [])
            .map((entry, index, list) => {
              const tone =
                entry.status === 'failed'
                  ? 'timeline__item--error'
                  : index === list.length - 1
                    ? 'timeline__item--active'
                    : 'timeline__item--done';
              return `<div class="timeline__item ${tone}">
                  <div class="timeline__rail"><span class="timeline__dot"></span>${index < list.length - 1 ? '<span class="timeline__line"></span>' : ''}</div>
                  <div class="timeline__body">
                    <p class="timeline__label">${esc(entry.label || entry.status)}</p>
                    ${entry.detail ? `<p class="timeline__detail">${esc(entry.detail)}</p>` : ''}
                    <p class="timeline__time">${esc(fmt.dateTime(entry.at))} · ${esc(fmt.relative(entry.at))}</p>
                  </div>
                </div>`;
            })
            .join('')}
        </div>
      </div>
      <div>
        <p class="eyebrow" style="margin-bottom:8px">Technical</p>
        <div class="detail-meta">
          <div class="detail-meta__item"><span class="detail-meta__label">Fax ID</span><span class="detail-meta__value detail-meta__value--mono">${esc(fax.id)}</span></div>
          <div class="detail-meta__item"><span class="detail-meta__label">Provider ref</span><span class="detail-meta__value detail-meta__value--mono">${esc(fax.provider_ref || '—')}</span></div>
          <div class="detail-meta__item"><span class="detail-meta__label">Attempts</span><span class="detail-meta__value">${fax.attempts} of ${fax.max_attempts}</span></div>
          <div class="detail-meta__item"><span class="detail-meta__label">Cost</span><span class="detail-meta__value detail-meta__value--mono">${esc(fmt.money(fax.cost_cents))}</span></div>
        </div>
      </div>`);

    const actions = [];
    actions.push(`<a class="btn btn--secondary" href="/api/faxes/${encodeURIComponent(fax.id)}/pdf" download>${icon('download', 14)} PDF</a>`);
    if (fax.direction === 'out' && !['delivered', 'cancelled'].includes(fax.status)) {
      actions.push(`<button class="btn btn--secondary" type="button" data-drawer-action="cancel">${icon('x', 14)} Cancel</button>`);
    }
    if (fax.direction === 'out' && ['failed', 'cancelled', 'delivered'].includes(fax.status)) {
      actions.push(`<button class="btn btn--primary" type="button" data-drawer-action="retry">${icon('refresh', 14)} ${fax.status === 'delivered' ? 'Send again' : 'Retry'}</button>`);
    }
    if (fax.direction === 'in' && !fax.read) {
      actions.push(`<button class="btn btn--secondary" type="button" data-drawer-action="read">${icon('check', 14)} Mark read</button>`);
    }
    actions.push(`<button class="btn btn--ghost" type="button" data-drawer-action="star">${icon('star', 14)} ${fax.starred ? 'Unstar' : 'Star'}</button>`);
    actions.push(`<button class="btn btn--ghost" type="button" data-drawer-action="delete" style="margin-left:auto;color:var(--danger)">${icon('trash', 14)}</button>`);
    handle.setFoot(actions.join(''));

    const pageButtons = $$('.page-thumb', handle.body);
    pageButtons.forEach((button) => {
      button.addEventListener('click', () => {
        pageButtons.forEach((item) => item.setAttribute('aria-current', String(item === button)));
        handle.body.querySelector('.fax-preview-large')?.remove();
      });
    });

    const act = async (action) => {
      try {
        if (action === 'cancel') {
          await api.post(`/api/faxes/${fax.id}/cancel`);
          toast.info('Fax cancelled');
        } else if (action === 'retry') {
          await api.post(`/api/faxes/${fax.id}/retry`, {});
          toast.success('Fax queued again');
        } else if (action === 'read') {
          await api.post(`/api/faxes/${fax.id}/read`, {});
          state.counts.unread = Math.max(0, state.counts.unread - 1);
        } else if (action === 'star') {
          await api.post(`/api/faxes/${fax.id}/star`, { starred: !fax.starred });
        } else if (action === 'delete') {
          await api.del(`/api/faxes/${fax.id}`);
          toast.success('Fax deleted');
          handle.close();
          refreshStatsSoon(true);
          return;
        }
        refreshChrome();
        await paint();
      } catch (error) {
        toast.error('Action failed', error.message);
      }
    };
    handle.foot?.querySelectorAll('[data-drawer-action]').forEach((button) => {
      button.addEventListener('click', () => act(button.dataset.drawerAction));
    });
    handle.el.querySelector('[data-body]').setAttribute('aria-busy', 'false');
    return fax;
  };

  try {
    const fax = await paint();
    // Live-refresh this panel while it stays open.
    state.faxListener = (updated) => {
      if (updated.id !== id) return;
      paint().catch(() => {});
    };
    return fax;
  } catch (error) {
    handle.setBody(`<div class="empty"><div class="empty__icon">${icon('alert', 18)}</div>
      <p class="empty__title">Could not open this fax</p><p class="empty__text">${esc(error.message)}</p></div>`);
    return null;
  }
}

/* ----------------------------------------------------------------- palette */

const paletteState = { items: [], filtered: [], active: 0, handle: null };

function paletteItems() {
  const navItems = Object.values(ROUTES).map((route) => ({
    group: 'Navigate',
    label: route.title,
    hint: route.path,
    icon: 'arrowRight',
    run: () => navigate(route.path),
  }));
  const actions = [
    {
      group: 'Actions',
      label: 'Compose a new fax',
      hint: 'N',
      icon: 'send',
      run: () => navigate('/send'),
    },
    {
      group: 'Actions',
      label: 'Toggle theme',
      hint: 'T',
      icon: 'moon',
      run: () => cycleTheme(),
    },
    {
      group: 'Actions',
      label: 'Receive a demo inbound fax',
      hint: 'S',
      icon: 'inbox',
      run: async () => {
        try {
          await api.post('/api/dev/simulate-inbound', {});
          toast.info('Inbound fax simulated');
          refreshStatsSoon(true);
        } catch (error) {
          toast.error('Simulation failed', error.message);
        }
      },
    },
    {
      group: 'Actions',
      label: 'Copy API quickstart',
      hint: 'C',
      icon: 'terminal',
      run: async () => {
        await copyText(API_SNIPPET);
        toast.success('cURL quickstart copied');
      },
    },
  ];
  const faxItems = state.faxes.slice(0, 24).map((fax) => ({
    group: 'Faxes',
    label: fax.subject || 'Untitled fax',
    hint: `${fax.direction === 'in' ? 'From' : 'To'} ${fax.direction === 'in' ? fax.from_number : fax.to_number}`,
    meta: statusMeta(fax.status).label,
    icon: fax.direction === 'in' ? 'inbox' : 'send',
    run: () => openFax(fax.id),
  }));
  const contactItems = state.contacts.map((contact) => ({
    group: 'Contacts',
    label: contact.name,
    hint: contact.fax,
    icon: 'contacts',
    run: () => navigate(`/send?to=${encodeURIComponent(contact.fax)}&name=${encodeURIComponent(contact.name)}`),
  }));
  return [...actions, ...navItems, ...faxItems, ...contactItems];
}

const API_SNIPPET = `curl -X POST http://127.0.0.1:4321/api/v1/faxes \\
  -H "Authorization: Bearer fx_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+1 212 555 0110","subject":"Signed NDA","note":"Attached."}'`;

function fuzzy(query, text) {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const haystack = text.toLowerCase();
  if (haystack.includes(q)) return true;
  let index = 0;
  for (const char of q) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function renderPaletteList() {
  const list = $('#palette-list');
  if (!list) return;
  if (!paletteState.filtered.length) {
    list.innerHTML = `<p class="palette__empty">No matches. Try “send”, “inbox” or a fax number.</p>`;
    return;
  }
  let lastGroup = '';
  list.innerHTML = paletteState.filtered
    .map((item, index) => {
      const header = item.group !== lastGroup ? `<p class="palette__group">${esc(item.group)}</p>` : '';
      lastGroup = item.group;
      return `${header}<button class="palette__item" type="button" data-index="${index}" data-active="${index === paletteState.active}">
        ${icon(item.icon || 'dot', 14)}
        <span class="truncate">${esc(item.label)}</span>
        <span class="palette__item-meta">${item.meta ? `<span>${esc(item.meta)}</span>` : ''}${item.hint ? `<span>${esc(item.hint)}</span>` : ''}</span>
      </button>`;
    })
    .join('');
  const activeEl = list.querySelector('[data-active="true"]');
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  if (paletteState.handle) return;
  paletteState.items = paletteItems();
  paletteState.filtered = paletteState.items;
  paletteState.active = 0;
  const backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.id = 'palette';
  backdrop.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette__search">${icon('search', 16)}
        <input type="text" placeholder="Search faxes, contacts, pages and actions…" aria-label="Search workspace" autocomplete="off" spellcheck="false" />
        <kbd>Esc</kbd>
      </div>
      <div class="palette__list" id="palette-list"></div>
      <div class="palette__foot"><span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span></div>
    </div>`;
  $('#palette-root').appendChild(backdrop);
  const input = backdrop.querySelector('input');
  const close = () => {
    backdrop.remove();
    paletteState.handle = null;
  };
  paletteState.handle = { close };

  const run = (item) => {
    close();
    item?.run?.();
  };

  const filter = () => {
    const query = input.value;
    paletteState.filtered = paletteState.items.filter((item) =>
      fuzzy(query, `${item.group} ${item.label} ${item.hint || ''} ${item.meta || ''}`),
    );
    paletteState.active = 0;
    renderPaletteList();
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      paletteState.active = Math.min(paletteState.filtered.length - 1, paletteState.active + 1);
      renderPaletteList();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      paletteState.active = Math.max(0, paletteState.active - 1);
      renderPaletteList();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(paletteState.filtered[paletteState.active]);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  on(backdrop, 'click', '.palette__item', (_event, element) => {
    run(paletteState.filtered[Number(element.dataset.index)]);
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && paletteState.handle) close();
    },
    { once: true },
  );
  renderPaletteList();
  setTimeout(() => input.focus(), 30);
}

/* ---------------------------------------------------------------- keyboard */

const chord = { key: null, timer: null };

function setupKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === 'Escape') {
      if (paletteState.handle) paletteState.handle.close();
      else closeTopOverlay();
      return;
    }
    if (typing) return;
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector('.filters .input, .search-trigger')?.focus?.();
      if (state.route === '/contacts' || state.route === '/outbox' || state.route === '/inbox') {
        $$('.filters .input').forEach((input) => input.focus());
      }
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      openShortcuts();
      return;
    }
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      navigate('/send');
      return;
    }
    const key = event.key.toLowerCase();
    if (chord.key === 'g') {
      const map = {
        o: '/overview',
        s: '/send',
        x: '/outbox',
        i: '/inbox',
        c: '/contacts',
        n: '/numbers',
        a: '/analytics',
        d: '/developer',
        ',': '/settings',
      };
      if (map[key]) {
        event.preventDefault();
        chord.key = null;
        clearTimeout(chord.timer);
        navigate(map[key]);
        return;
      }
    }
    if (key === 'g') {
      chord.key = 'g';
      clearTimeout(chord.timer);
      chord.timer = setTimeout(() => {
        chord.key = null;
      }, 1200);
    }
  });
}

function openShortcuts() {
  openModal({
    title: 'Keyboard shortcuts',
    sub: 'Work the queue without touching the mouse.',
    body: `<div class="stack" style="gap:2px">
      ${[
        ['⌘K / Ctrl K', 'Command palette'],
        ['G then O', 'Overview'],
        ['G then S', 'Send fax'],
        ['G then X', 'Outbox'],
        ['G then I', 'Inbox'],
        ['G then C', 'Contacts'],
        ['G then A', 'Analytics'],
        ['G then D', 'Developer'],
        ['N', 'Compose a new fax'],
        ['/', 'Focus search'],
        ['?', 'This dialog'],
        ['Esc', 'Close panel or dialog'],
      ]
        .map(
          ([keys, label]) => `<div class="row row--between" style="padding:7px 0;border-bottom:1px solid var(--border-subtle)">
          <span style="font-size:var(--fs-2);color:var(--muted)">${esc(label)}</span>
          <kbd>${esc(keys)}</kbd></div>`,
        )
        .join('')}
    </div>`,
    footer: `<button class="btn btn--primary" type="button" data-close-modal>Got it</button>`,
  }).foot.querySelector('[data-close-modal]').addEventListener('click', (event) => {
    event.target.closest('.overlay').remove();
    document.body.style.overflow = '';
  });
}

function openAccount() {
  const settings = state.settings || {};
  openModal({
    title: settings.userName || 'Account',
    sub: `${settings.userRole || 'Member'} · ${settings.workspaceName || 'Workspace'}`,
    body: `<div class="detail-meta">
        <div class="detail-meta__item"><span class="detail-meta__label">Email</span><span class="detail-meta__value detail-meta__value--mono">${esc(settings.userEmail || '—')}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Timezone</span><span class="detail-meta__value">${esc(settings.timezone || '—')}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Provider</span><span class="detail-meta__value">${esc(state.provider?.name || '—')}</span></div>
        <div class="detail-meta__item"><span class="detail-meta__label">Mode</span><span class="detail-meta__value">${esc(state.provider?.mode || 'simulated')}</span></div>
      </div>
      <div class="inline-note">Faxline runs as a single local workspace. Add access control in front of it before exposing the port publicly.</div>`,
    footer: `<a class="btn btn--secondary" href="/settings" data-link>Workspace settings</a>
      <button class="btn btn--primary" type="button" data-go-dev>Developer tools</button>`,
  });
  const modal = $('.modal');
  modal?.querySelector('[data-go-dev]')?.addEventListener('click', () => {
    closeTopOverlay();
    navigate('/developer');
  });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  try {
    await loadBootstrap();
  } catch (error) {
    $('#boot')?.remove();
    const app = $('#app');
    app.hidden = false;
    app.innerHTML = `<div style="max-width:520px;margin:14vh auto;padding:24px">
      <h1 class="page-title">Faxline cannot start</h1>
      <p class="page-sub" style="margin:8px 0 16px">${esc(error.message)}</p>
      <button class="btn btn--primary" onclick="location.reload()">Reload</button></div>`;
    return;
  }

  state.route = routeFromLocation();
  buildShell();
  state.ui.ready = true;
  applyTheme();

  bindActions(document, {
    'toggle-nav': () => {
      const app = $('#app');
      const next = app.getAttribute('data-nav') === 'open' ? 'closed' : 'open';
      app.setAttribute('data-nav', next);
      $('[data-action="toggle-nav"]')?.setAttribute('aria-expanded', String(next === 'open'));
    },
    'open-palette': () => openPalette(),
    'cycle-theme': () => cycleTheme(),
    'open-account': () => openAccount(),
  });

  on(document, 'click', 'a[data-link]', (event, anchor) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    if (url.pathname === state.route && !url.search) {
      renderRoute();
      return;
    }
    navigate(url.pathname + url.search);
  });

  window.addEventListener('popstate', () => {
    state.route = routeFromLocation();
    renderRoute();
  });

  setupKeyboard();
  if (matchMedia('(max-width: 980px)').matches) {
    $('#app').setAttribute('data-nav', 'closed');
  }
  connectStream();
  await renderRoute();
}

boot();
