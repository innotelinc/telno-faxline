/* Shared client primitives: fetch wrapper, formatting, icons, and overlays. */

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(
      error?.name === 'AbortError' ? 'Request cancelled.' : 'Cannot reach the Faxline server. Is it still running?',
      0,
      null,
    );
  }
  const type = response.headers.get('content-type') || '';
  let payload = null;
  if (type.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed with ${response.status}.`, response.status, payload?.details);
  }
  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload(files) {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request('/api/uploads', { method: 'POST', body: form });
  },
};

/* --------------------------------------------------------------------- dom */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function on(root, event, selector, handler) {
  if (!root) return () => {};
  const listener = (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (target && root.contains(target)) handler(ev, target);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

export function bindActions(root, actions) {
  return on(root, 'click', '[data-action]', (event, element) => {
    const name = element.dataset.action;
    const handler = actions[name];
    if (!handler) return;
    event.preventDefault();
    handler(element, event);
  });
}

/* ------------------------------------------------------------------ format */

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const fmt = {
  money(cents) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
  },
  num(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
  },
  pct(value) {
    const number = Number(value) || 0;
    return `${number % 1 === 0 ? number.toFixed(0) : number.toFixed(1)}%`;
  },
  date(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.getFullYear() === new Date().getFullYear() ? dateFmt.format(date) : dateYearFmt.format(date);
  },
  time(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : timeFmt.format(date);
  },
  dateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : dateTimeFmt.format(date);
  },
  full(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  },
  relative(value) {
    if (!value) return '—';
    const date = new Date(value);
    const diff = date.getTime() - Date.now();
    const abs = Math.abs(diff);
    const units = [
      ['year', 31536000000],
      ['month', 2592000000],
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000],
    ];
    for (const [unit, ms] of units) {
      if (abs >= ms) {
        const rounded = Math.round(diff / ms);
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(rounded, unit);
      }
    }
    return 'just now';
  },
  duration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 60) return `${value}s`;
    return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`;
  },
  bytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  },
  plural(count, singular, plural = `${singular}s`) {
    return `${fmt.num(count)} ${count === 1 ? singular : plural}`;
  },
};

export function initials(name) {
  const parts = String(name || '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ status */

export const STATUS = {
  queued: { label: 'Queued', tone: 'muted', icon: 'clock' },
  scheduled: { label: 'Scheduled', tone: 'info', icon: 'calendar' },
  sending: { label: 'Transmitting', tone: 'warning', icon: 'activity' },
  delivered: { label: 'Delivered', tone: 'success', icon: 'check' },
  received: { label: 'Received', tone: 'success', icon: 'inbox' },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert' },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: 'x' },
};

export function statusMeta(status) {
  return STATUS[status] || { label: status || 'Unknown', tone: 'muted', icon: 'dot' };
}

export function statusPill(status, label) {
  const meta = statusMeta(status);
  return `<span class="pill pill--${meta.tone}">${esc(label || meta.label)}</span>`;
}

export const QUALITY = {
  standard: { label: 'Standard', meta: '200 × 100 dpi · 7¢/page' },
  fine: { label: 'Fine', meta: '200 × 200 dpi · 9¢/page' },
  ultra: { label: 'Ultra', meta: '400 × 400 dpi · 12¢/page' },
};

/* ------------------------------------------------------------------- icons */

const ICONS = {
  overview:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  send: '<path d="M21.5 2.5 2.8 9.7a.6.6 0 0 0 .04 1.13l7.3 2.4 2.4 7.3a.6.6 0 0 0 1.13.04L21.5 2.5Z"/><path d="M10.2 13.3 21.5 2.5"/>',
  outbox: '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  inbox: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  contacts:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16.5 5.4a3.2 3.2 0 0 1 0 5.2"/><path d="M18 15.2c1.8.6 3 2.2 3 4.8"/>',
  numbers:
    '<path d="M9 3 7.5 21"/><path d="M16.5 3 15 21"/><path d="M4 9h16"/><path d="M3 15h16"/>',
  analytics: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  developer: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 10 2.5 2.5L7 15"/><path d="m13 15h4"/>',
  settings:
    '<path d="M4 6h9"/><path d="M17 6h3"/><path d="M4 12h3"/><path d="M11 12h9"/><path d="M4 18h9"/><path d="M17 18h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.6 8.6 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  activity: '<path d="M3 12h4l2.5-7 4 14L16 12h5"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13 3v6h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  download: '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.4 6"/><path d="M20 5v6h-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  star: '<path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 10l5.9-.9Z"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  arrowRight: '<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  arrowDownLeft: '<path d="M17 7 7 17"/><path d="M16 17H7V8"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8"/><path d="m15 4 5 5"/><path d="m13 6 3 3"/>',
  webhook: '<path d="M9.5 8a3.5 3.5 0 1 1 5 3.2"/><path d="M14.5 16a3.5 3.5 0 1 1-5-3.2"/><path d="M12 5V3M12 21v-2"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  sparkle: '<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8Z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  printer: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  terminal: '<path d="m5 8 4 4-4 4"/><path d="M12 16h7"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  sort: '<path d="M7 4v16"/><path d="m4 17 3 3 3-3"/><path d="M17 20V4"/><path d="m14 7 3-3 3 3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  rotate: '<path d="M4 10a8 8 0 1 1 2.3 7"/><path d="M4 4v6h6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
};

export function icon(name, size = 16, cls = '') {
  const body = ICONS[name] || ICONS.dot;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true">${body}</svg>`;
}

/* ------------------------------------------------------------------ toasts */

export function toast(input, options = {}) {
  const region = $('#toast-region');
  if (!region) return () => {};
  const config = typeof input === 'string' ? { title: input, ...options } : input || {};
  const tone = config.tone || 'info';
  const iconName = { success: 'check', error: 'alert', warn: 'alert', info: 'sparkle' }[tone] || 'sparkle';
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.innerHTML = `
    <div class="toast__icon">${icon(iconName, 13)}</div>
    <div class="toast__body">
      <div class="toast__title">${esc(config.title || '')}</div>
      ${config.text ? `<div class="toast__text">${esc(config.text)}</div>` : ''}
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss">${icon('x', 13)}</button>`;
  region.appendChild(el);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  };
  el.querySelector('.toast__close').addEventListener('click', remove);
  const timeout = config.timeout ?? (tone === 'error' ? 8000 : 5000);
  if (timeout > 0) setTimeout(remove, timeout);
  return remove;
}

toast.success = (title, text) => toast({ tone: 'success', title, text });
toast.error = (title, text) => toast({ tone: 'error', title, text });
toast.info = (title, text) => toast({ tone: 'info', title, text });
toast.warn = (title, text) => toast({ tone: 'warn', title, text });

/* ----------------------------------------------------------------- overlays */

const openOverlays = new Set();

function trapFocus(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return (event) => {
    if (event.key !== 'Tab') return;
    const items = $$(selector, container).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

export function openModal({ title, sub = '', body = '', footer = '', size = '' }) {
  const previous = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal ${size === 'wide' ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal__head">
        <div>
          <h2 class="modal__title">${esc(title)}</h2>
          ${sub ? `<p class="modal__sub">${esc(sub)}</p>` : ''}
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon('x', 16)}</button>
      </div>
      <div class="modal__body" data-body>${body}</div>
      ${footer ? `<div class="modal__foot" data-foot>${footer}</div>` : ''}
    </div>`;
  const root = $('#overlay-root');
  root.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const modal = overlay.querySelector('.modal');
  const handle = {
    el: modal,
    body: overlay.querySelector('[data-body]'),
    foot: overlay.querySelector('[data-foot]'),
    close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      openOverlays.delete(handle);
      if (!openOverlays.size) document.body.style.overflow = '';
      previous?.focus?.();
      handle.onClose?.(result);
    },
    setBody(html) {
      handle.body.innerHTML = html;
    },
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handle.close();
    }
    trapFocus(modal)(event);
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) handle.close();
  });
  overlay.querySelector('[data-close]').addEventListener('click', () => handle.close());
  openOverlays.add(handle);
  setTimeout(() => {
    const focusTarget = modal.querySelector('[autofocus], input, select, textarea, button:not([data-close])');
    focusTarget?.focus();
  }, 30);
  return handle;
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      body: `<p style="color:var(--muted);line-height:1.6">${esc(message)}</p>`,
      footer: `
        <button class="btn btn--secondary" type="button" data-cancel>${esc(cancelLabel)}</button>
        <button class="btn btn--${tone === 'danger' ? 'danger' : 'primary'}" type="button" data-confirm>${esc(confirmLabel)}</button>`,
    });
    modal.foot.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    modal.foot.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
    modal.onClose = () => finish(false);
  });
}

export function openDrawer({ title, sub = '', body = '', footer = '', onClose }) {
  const previous = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', title);
  drawer.innerHTML = `
    <div class="drawer__head">
      <div class="drawer__head-text">
        <h2 class="drawer__title">${esc(title)}</h2>
        <div data-sub>${sub}</div>
      </div>
      <button class="icon-btn" type="button" data-close aria-label="Close panel">${icon('x', 16)}</button>
    </div>
    <div class="drawer__body" data-body>${body}</div>
    ${footer ? `<div class="drawer__foot" data-foot>${footer}</div>` : ''}`;
  $('#overlay-root').append(backdrop, drawer);
  document.body.style.overflow = 'hidden';

  const handle = {
    el: drawer,
    body: drawer.querySelector('[data-body]'),
    foot: drawer.querySelector('[data-foot]'),
    sub: drawer.querySelector('[data-sub]'),
    close() {
      drawer.remove();
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      openOverlays.delete(handle);
      if (!openOverlays.size) document.body.style.overflow = '';
      previous?.focus?.();
      onClose?.();
    },
    setBody(html) {
      handle.body.innerHTML = html;
    },
    setFoot(html) {
      if (!handle.foot) {
        const foot = document.createElement('div');
        foot.className = 'drawer__foot';
        foot.dataset.foot = '';
        drawer.append(foot);
        handle.foot = foot;
      }
      handle.foot.innerHTML = html;
    },
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handle.close();
    }
    trapFocus(drawer)(event);
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', () => handle.close());
  drawer.querySelector('[data-close]').addEventListener('click', () => handle.close());
  openOverlays.add(handle);
  setTimeout(() => drawer.querySelector('[data-close]')?.focus(), 40);
  return handle;
}

export function closeTopOverlay() {
  const last = Array.from(openOverlays).pop();
  last?.close?.();
  return Boolean(last);
}

/* ------------------------------------------------------------------ helpers */

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    return Boolean(ok);
  }
}

export function emptyState({ iconName = 'file', title, text, action = '' }) {
  return `
    <div class="empty">
      <div class="empty__icon">${icon(iconName, 18)}</div>
      <p class="empty__title">${esc(title)}</p>
      <p class="empty__text">${esc(text)}</p>
      ${action}
    </div>`;
}

export function spinner() {
  return '<span class="btn__spinner" aria-hidden="true"></span>';
}
