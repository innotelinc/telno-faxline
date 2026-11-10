import crypto from 'node:crypto';

export const uid = (prefix = 'id') => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export const nowIso = () => new Date().toISOString();

export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const digits = (value = '') => String(value).replace(/\D+/g, '');

/** Formats common North American numbers and keeps other international numbers in E.164-ish form. */
export function normalizeFaxNumber(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const d = digits(raw);
  if (!d) return '';
  if (raw.startsWith('+')) {
    if (d.length === 11 && d.startsWith('1')) {
      return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    }
    return `+${d}`;
  }
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return raw;
}

export function isValidFaxNumber(value) {
  const d = digits(value);
  return d.length >= 8 && d.length <= 15;
}

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());

export const isHttpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
export const escapeXml = (value) => String(value ?? '').replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);

const HTML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[<>&'"]/g, (c) => HTML_ESCAPES[c]);

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export const hmacSha256 = (secret, body) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

export function dayKey(value, timeZone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function startOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Deterministic PRNG so the demo workspace looks identical on every reset. */
export function seededRandom(seed = 42) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (list, random) => list[Math.floor(random() * list.length)];

export function safeFileName(name, fallback = 'document.pdf') {
  const cleaned = String(name ?? '')
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
