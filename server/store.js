import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  dayKey,
  formatBytes,
  nowIso,
  parseJson,
  pick,
  safeFileName,
  seededRandom,
  uid,
} from './util.js';
import { buildFaxRender } from './render.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'faxline.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS numbers (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  label TEXT,
  region TEXT,
  country TEXT,
  capabilities TEXT,
  status TEXT,
  monthly_cents INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  inbound_count INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT,
  company TEXT,
  fax TEXT,
  email TEXT,
  group_name TEXT,
  favorite INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT,
  last_fax_at TEXT
);
CREATE TABLE IF NOT EXISTS faxes (
  id TEXT PRIMARY KEY,
  direction TEXT,
  status TEXT,
  from_number TEXT,
  to_number TEXT,
  recipient_name TEXT,
  subject TEXT,
  note TEXT,
  pages INTEGER DEFAULT 1,
  quality TEXT,
  scheduled_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  duration_sec INTEGER,
  cost_cents INTEGER DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  provider TEXT,
  provider_ref TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  starred INTEGER DEFAULT 0,
  read INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  tags TEXT,
  cover_template TEXT,
  documents TEXT,
  timeline TEXT,
  render TEXT,
  priority TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT,
  mime TEXT,
  size INTEGER,
  pages INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT,
  prefix TEXT,
  hash TEXT,
  scopes TEXT,
  created_at TEXT,
  last_used_at TEXT,
  revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT,
  level TEXT,
  fax_id TEXT,
  message TEXT,
  meta TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  fax_id TEXT,
  url TEXT,
  status_code INTEGER,
  ok INTEGER,
  attempt INTEGER,
  payload TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_faxes_created ON faxes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_faxes_status ON faxes (status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);
`);

export const DEFAULT_SETTINGS = {
  workspaceName: 'Meridian Group',
  userName: 'Avery Chen',
  userRole: 'Fax operations',
  userEmail: 'ops@meridiangroup.com',
  timezone: 'America/Los_Angeles',
  senderName: 'Meridian Group',
  defaultNumberId: '',
  retentionDays: 90,
  coverTemplate: 'branded',
  accent: '#757cf2',
  coverHeader: 'Meridian Group',
  coverFooter:
    'This transmission is confidential and intended only for the recipient named above. If received in error, please notify the sender and destroy all copies.',
  showPageNumbers: true,
  notifyDelivered: true,
  notifyFailed: true,
  dailyDigest: false,
  theme: 'system',
  density: 'comfortable',
  webhookUrl: '',
  webhookSecret: '',
  webhookEvents: ['fax.delivered', 'fax.failed', 'fax.received'],
};

const FAX_RATES = { standard: 7, fine: 9, ultra: 12 };
export const rateFor = (quality) => FAX_RATES[quality] ?? FAX_RATES.standard;

const toBool = (value) => value === 1 || value === true || value === '1';

function rowToFax(row) {
  if (!row) return null;
  return {
    ...row,
    pages: Number(row.pages) || 1,
    cost_cents: Number(row.cost_cents) || 0,
    attempts: Number(row.attempts) || 0,
    max_attempts: Number(row.max_attempts) || 3,
    starred: toBool(row.starred),
    read: toBool(row.read),
    archived: toBool(row.archived),
    tags: parseJson(row.tags, []),
    documents: parseJson(row.documents, []),
    timeline: parseJson(row.timeline, []),
    render: parseJson(row.render, null),
  };
}

function rowToNumber(row) {
  if (!row) return null;
  return {
    ...row,
    capabilities: parseJson(row.capabilities, ['send', 'receive']),
    is_default: toBool(row.is_default),
    monthly_cents: Number(row.monthly_cents) || 0,
    inbound_count: Number(row.inbound_count) || 0,
  };
}

function rowToContact(row) {
  if (!row) return null;
  return { ...row, favorite: toBool(row.favorite) };
}

function rowToEvent(row) {
  if (!row) return null;
  return { ...row, meta: parseJson(row.meta, null) };
}

/* ------------------------------------------------------------------ settings */

function readSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of rows) stored[row.key] = parseJson(row.value, row.value);
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.webhookEvents = Array.isArray(merged.webhookEvents) ? merged.webhookEvents : DEFAULT_SETTINGS.webhookEvents;
  return merged;
}

function writeSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

const settings = {
  get: readSettings,
  update(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const [key, value] of Object.entries(patch || {})) {
      if (!allowed.includes(key)) continue;
      writeSetting(key, value);
    }
    const next = readSettings();
    if (!next.webhookSecret) {
      writeSetting('webhookSecret', uid('whsec').replace('whsec_', 'whsec_'));
    }
    return readSettings();
  },
  ensureDefaults() {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) writeSetting(key, value);
    writeSetting('webhookSecret', uid('whsec'));
    return readSettings();
  },
};

/* ------------------------------------------------------------------- numbers */

const numbers = {
  list() {
    return db
      .prepare('SELECT * FROM numbers ORDER BY is_default DESC, created_at ASC')
      .all()
      .map(rowToNumber);
  },
  get(id) {
    return rowToNumber(db.prepare('SELECT * FROM numbers WHERE id = ?').get(id));
  },
  default() {
    const current = readSettings();
    const preferred = current.defaultNumberId ? numbers.get(current.defaultNumberId) : null;
    if (preferred) return preferred;
    const rows = numbers.list();
    return rows.find((n) => n.is_default) ?? rows[0] ?? null;
  },
  insert(input) {
    const row = {
      id: uid('num'),
      number: input.number,
      label: input.label || 'New number',
      region: input.region || 'US',
      country: input.country || 'US',
      capabilities: JSON.stringify(input.capabilities ?? ['send', 'receive']),
      status: input.status || 'active',
      monthly_cents: input.monthly_cents ?? 495,
      is_default: input.is_default ? 1 : 0,
      inbound_count: 0,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO numbers (id, number, label, region, country, capabilities, status, monthly_cents, is_default, inbound_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.number,
      row.label,
      row.region,
      row.country,
      row.capabilities,
      row.status,
      row.monthly_cents,
      row.is_default,
      row.inbound_count,
      row.created_at,
    );
    if (row.is_default) {
      db.prepare('UPDATE numbers SET is_default = 0 WHERE id != ?').run(row.id);
      writeSetting('defaultNumberId', row.id);
    }
    return numbers.get(row.id);
  },
  update(id, patch) {
    const current = numbers.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare(
      `UPDATE numbers SET label = ?, region = ?, capabilities = ?, status = ?, monthly_cents = ?, is_default = ? WHERE id = ?`,
    ).run(
      String(next.label ?? '').slice(0, 80),
      String(next.region ?? ''),
      JSON.stringify(next.capabilities ?? ['send', 'receive']),
      next.status ?? 'active',
      Number(next.monthly_cents) || 0,
      next.is_default ? 1 : 0,
      id,
    );
    if (next.is_default) {
      db.prepare('UPDATE numbers SET is_default = 0 WHERE id != ?').run(id);
      writeSetting('defaultNumberId', id);
    }
    return numbers.get(id);
  },
  incrementInbound(id) {
    db.prepare('UPDATE numbers SET inbound_count = inbound_count + 1 WHERE id = ?').run(id);
  },
  remove(id) {
    db.prepare('DELETE FROM numbers WHERE id = ?').run(id);
    const current = readSettings();
    if (current.defaultNumberId === id) writeSetting('defaultNumberId', numbers.default()?.id ?? '');
    return true;
  },
};

/* ------------------------------------------------------------------ contacts */

const contacts = {
  list() {
    return db
      .prepare('SELECT * FROM contacts ORDER BY favorite DESC, name COLLATE NOCASE ASC')
      .all()
      .map(rowToContact);
  },
  get(id) {
    return rowToContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
  },
  findByFax(fax) {
    return rowToContact(db.prepare('SELECT * FROM contacts WHERE fax = ?').get(fax));
  },
  insert(input) {
    const row = {
      id: uid('con'),
      name: input.name,
      company: input.company || '',
      fax: input.fax,
      email: input.email || '',
      group_name: input.group_name || 'General',
      favorite: input.favorite ? 1 : 0,
      notes: input.notes || '',
      created_at: nowIso(),
      last_fax_at: input.last_fax_at || null,
    };
    db.prepare(
      `INSERT INTO contacts (id, name, company, fax, email, group_name, favorite, notes, created_at, last_fax_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.name,
      row.company,
      row.fax,
      row.email,
      row.group_name,
      row.favorite,
      row.notes,
      row.created_at,
      row.last_fax_at,
    );
    return contacts.get(row.id);
  },
  update(id, patch) {
    const current = contacts.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare(
      `UPDATE contacts SET name = ?, company = ?, fax = ?, email = ?, group_name = ?, favorite = ?, notes = ? WHERE id = ?`,
    ).run(
      String(next.name ?? '').slice(0, 120),
      String(next.company ?? '').slice(0, 120),
      next.fax,
      String(next.email ?? '').slice(0, 160),
      String(next.group_name ?? 'General').slice(0, 60),
      next.favorite ? 1 : 0,
      String(next.notes ?? '').slice(0, 1000),
      id,
    );
    return contacts.get(id);
  },
  touch(id) {
    db.prepare('UPDATE contacts SET last_fax_at = ? WHERE id = ?').run(nowIso(), id);
  },
  remove(id) {
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    return true;
  },
};

/* --------------------------------------------------------------------- files */

const files = {
  save(buffer, meta) {
    const id = uid('doc');
    const name = safeFileName(meta.name, 'document.pdf');
    fs.writeFileSync(path.join(FILES_DIR, id), buffer);
    db.prepare('INSERT INTO files (id, name, mime, size, pages, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      name,
      meta.mime || 'application/octet-stream',
      buffer.length,
      Math.max(1, Number(meta.pages) || 1),
      nowIso(),
    );
    return files.get(id);
  },
  get(id) {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      sizeLabel: formatBytes(row.size),
      url: `/api/files/${row.id}`,
      kind: String(row.mime || '').startsWith('image/') ? 'image' : 'pdf',
    };
  },
  read(id) {
    const meta = files.get(id);
    if (!meta) return null;
    const filePath = path.join(FILES_DIR, id);
    if (!fs.existsSync(filePath)) return null;
    return { meta, buffer: fs.readFileSync(filePath) };
  },
  remove(id) {
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    try {
      fs.unlinkSync(path.join(FILES_DIR, id));
    } catch {
      /* already gone */
    }
    return true;
  },
};

/* --------------------------------------------------------------------- faxes */

const FAX_COLUMNS = [
  'direction',
  'status',
  'from_number',
  'to_number',
  'recipient_name',
  'subject',
  'note',
  'pages',
  'quality',
  'scheduled_at',
  'created_at',
  'updated_at',
  'completed_at',
  'duration_sec',
  'cost_cents',
  'error_code',
  'error_message',
  'provider',
  'provider_ref',
  'attempts',
  'max_attempts',
  'starred',
  'read',
  'archived',
  'tags',
  'cover_template',
  'documents',
  'timeline',
  'render',
  'priority',
];

const JSON_COLUMNS = new Set(['tags', 'documents', 'timeline', 'render']);
const BOOL_COLUMNS = new Set(['starred', 'read', 'archived']);

function serializeFaxValue(column, value) {
  if (JSON_COLUMNS.has(column)) {
    // Accept both live objects and values that were serialized by a caller.
    if (typeof value === 'string') return value;
    return JSON.stringify(value ?? (column === 'render' ? null : []));
  }
  if (BOOL_COLUMNS.has(column)) return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

const faxes = {
  list(options = {}) {
    const {
      direction,
      status,
      search,
      starred,
      unread,
      limit = 50,
      offset = 0,
      from,
      to,
      sort = 'newest',
    } = options;
    const where = [];
    const params = [];
    if (direction && direction !== 'all') {
      where.push('direction = ?');
      params.push(direction);
    }
    if (status && status !== 'all') {
      if (status === 'active') {
        where.push("status IN ('queued','sending','scheduled')");
      } else if (status === 'failed') {
        where.push("status IN ('failed','cancelled')");
      } else {
        where.push('status = ?');
        params.push(status);
      }
    }
    if (starred) where.push('starred = 1');
    if (unread) where.push('read = 0');
    if (from) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(to);
    }
    if (search) {
      where.push('(subject LIKE ? OR recipient_name LIKE ? OR to_number LIKE ? OR from_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      sort === 'oldest'
        ? 'created_at ASC'
        : sort === 'pages'
          ? 'pages DESC, created_at DESC'
          : 'created_at DESC';
    const rows = db
      .prepare(`SELECT * FROM faxes ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, Math.max(1, Number(limit))), Math.max(0, Number(offset)));
    const total = db.prepare(`SELECT COUNT(*) AS c FROM faxes ${clause}`).get(...params).c;
    return { items: rows.map(rowToFax), total: Number(total) };
  },
  get(id) {
    return rowToFax(db.prepare('SELECT * FROM faxes WHERE id = ?').get(id));
  },
  byProviderRef(ref) {
    return rowToFax(db.prepare('SELECT * FROM faxes WHERE provider_ref = ?').get(ref));
  },
  insert(input) {
    const row = {
      id: input.id || uid('fax'),
      direction: input.direction || 'out',
      status: input.status || 'queued',
      from_number: input.from_number || '',
      to_number: input.to_number || '',
      recipient_name: input.recipient_name || '',
      subject: input.subject || '',
      note: input.note || '',
      pages: Number(input.pages) || 1,
      quality: input.quality || 'standard',
      scheduled_at: input.scheduled_at || null,
      created_at: input.created_at || nowIso(),
      updated_at: nowIso(),
      completed_at: input.completed_at || null,
      duration_sec: input.duration_sec ?? null,
      cost_cents: Number(input.cost_cents) || 0,
      error_code: input.error_code || null,
      error_message: input.error_message || null,
      provider: input.provider || 'simulator',
      provider_ref: input.provider_ref || null,
      attempts: Number(input.attempts) || 0,
      max_attempts: Number(input.max_attempts) || 3,
      starred: input.starred ? 1 : 0,
      read: input.read === false ? 0 : 1,
      archived: 0,
      tags: input.tags || [],
      cover_template: input.cover_template || readSettings().coverTemplate,
      documents: input.documents || [],
      timeline: input.timeline || [],
      render: input.render || null,
      priority: input.priority || 'normal',
    };
    const placeholders = ['id', ...FAX_COLUMNS].map(() => '?').join(', ');
    db.prepare(`INSERT INTO faxes (id, ${FAX_COLUMNS.join(', ')}) VALUES (${placeholders})`).run(
      row.id,
      ...FAX_COLUMNS.map((column) => serializeFaxValue(column, row[column])),
    );
    return faxes.get(row.id);
  },
  update(id, patch) {
    const current = faxes.get(id);
    if (!current) return null;
    const columns = Object.keys(patch).filter((key) => FAX_COLUMNS.includes(key));
    if (!columns.length) return current;
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    db.prepare(`UPDATE faxes SET ${assignments}, updated_at = ? WHERE id = ?`).run(
      ...columns.map((column) => serializeFaxValue(column, patch[column])),
      nowIso(),
      id,
    );
    return faxes.get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM faxes WHERE id = ?').run(id);
    return true;
  },
  count(predicate = {}) {
    const where = [];
    const params = [];
    for (const [key, value] of Object.entries(predicate)) {
      where.push(`${key} = ?`);
      params.push(value);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM faxes ${clause}`).get(...params).c);
  },
};

/* -------------------------------------------------------------------- events */

const events = {
  list(limit = 30) {
    return db
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(200, Math.max(1, Number(limit))))
      .map(rowToEvent);
  },
  log({ type, level = 'info', faxId = null, message = '', meta = null }) {
    const row = {
      id: uid('evt'),
      type,
      level,
      fax_id: faxId,
      message,
      meta: meta ? JSON.stringify(meta) : null,
      created_at: nowIso(),
    };
    db.prepare(
      'INSERT INTO events (id, type, level, fax_id, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.type, row.level, row.fax_id, row.message, row.meta, row.created_at);
    return rowToEvent(row);
  },
};

/* ---------------------------------------------------------------------- keys */

const keys = {
  list() {
    return db
      .prepare('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked FROM api_keys ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        ...row,
        revoked: toBool(row.revoked),
        scopes: parseJson(row.scopes, ['read', 'write']),
      }));
  },
  insert({ name, hash, prefix, scopes = ['read', 'write'] }) {
    const row = {
      id: uid('key'),
      name,
      prefix,
      hash,
      scopes: JSON.stringify(scopes),
      created_at: nowIso(),
      last_used_at: null,
      revoked: 0,
    };
    db.prepare(
      'INSERT INTO api_keys (id, name, prefix, hash, scopes, created_at, last_used_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.prefix, row.hash, row.scopes, row.created_at, row.last_used_at, row.revoked);
    return { ...row, scopes, revoked: false };
  },
  findByHash(hash) {
    return db.prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked = 0').get(hash) ?? null;
  },
  touch(id) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
  },
  revoke(id) {
    db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
    return true;
  },
};

/* --------------------------------------------------------------- deliveries */

const deliveries = {
  list(limit = 20) {
    return db
      .prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(100, Math.max(1, Number(limit))))
      .map((row) => ({ ...row, ok: toBool(row.ok), payload: parseJson(row.payload, null) }));
  },
  insert({ faxId, url, statusCode, ok, attempt, payload }) {
    const id = uid('dlv');
    db.prepare(
      'INSERT INTO deliveries (id, fax_id, url, status_code, ok, attempt, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, faxId, url, statusCode ?? null, ok ? 1 : 0, attempt ?? 1, JSON.stringify(payload ?? null), nowIso());
    return id;
  },
};

/* --------------------------------------------------------------------- stats */

function stats(days = 30) {
  const current = readSettings();
  const tz = current.timezone || 'America/Los_Angeles';
  const since = addDays(new Date(), -(days - 1));
  since.setUTCHours(0, 0, 0, 0);
  const rows = db.prepare('SELECT * FROM faxes WHERE created_at >= ?').all(since.toISOString()).map(rowToFax);

  const series = new Map();
  for (let i = 0; i < days; i += 1) {
    const key = dayKey(addDays(since, i), tz);
    series.set(key, { date: key, sent: 0, received: 0, failed: 0, pages: 0, cost: 0 });
  }

  let sent = 0;
  let received = 0;
  let delivered = 0;
  let failed = 0;
  let pages = 0;
  let spend = 0;
  let deliveredSeconds = 0;
  const destinations = new Map();
  const hours = Array.from({ length: 24 }, () => 0);

  for (const fax of rows) {
    const key = dayKey(fax.created_at, tz);
    const bucket = series.get(key);
    const hour = new Date(fax.created_at).getHours();
    if (fax.direction === 'out') {
      hours[hour] += 1;
      sent += 1;
      if (bucket) bucket.sent += 1;
      if (fax.status === 'delivered') {
        delivered += 1;
        deliveredSeconds += Number(fax.duration_sec) || 0;
      }
      if (fax.status === 'failed') {
        failed += 1;
        if (bucket) bucket.failed += 1;
      }
      const label = fax.recipient_name || fax.to_number;
      destinations.set(label, (destinations.get(label) || 0) + 1);
      spend += Number(fax.cost_cents) || 0;
      if (bucket) bucket.cost += Number(fax.cost_cents) || 0;
    } else {
      received += 1;
      if (bucket) bucket.received += 1;
    }
    pages += Number(fax.pages) || 0;
    if (bucket) bucket.pages += Number(fax.pages) || 0;
  }

  const completed = delivered + failed;
  return {
    days,
    sent,
    received,
    delivered,
    failed,
    pages,
    spendCents: spend,
    successRate: completed ? Math.round((delivered / completed) * 1000) / 10 : 100,
    avgSeconds: delivered ? Math.round(deliveredSeconds / delivered) : 0,
    series: Array.from(series.values()),
    topDestinations: Array.from(destinations.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    hours,
    monthlyCents: numbers.list().reduce((sum, n) => sum + n.monthly_cents, 0),
  };
}

/* ---------------------------------------------------------------------- seed */

const SEED_NUMBERS = [
  { number: '+1 (415) 555-0142', label: 'HQ · San Francisco', region: 'US-CA', monthly: 495, isDefault: true, inbound: 41 },
  { number: '+1 (212) 555-0188', label: 'New York desk', region: 'US-NY', monthly: 395, inbound: 23 },
  { number: '+1 (312) 555-0119', label: 'Chicago desk', region: 'US-IL', monthly: 295, inbound: 12 },
  { number: '+44 20 7946 0812', label: 'London office', region: 'GB-LND', monthly: 695, inbound: 8 },
];

const SEED_CONTACTS = [
  { name: 'Priya Raman', company: 'Acme Holdings', fax: '+1 (212) 555-0110', email: 'priya@acmeholdings.com', group: 'Legal', favorite: true },
  { name: 'Marcus Webb', company: 'Northwind Labs', fax: '+1 (415) 555-0177', email: 'm.webb@northwindlabs.io', group: 'Clients', favorite: true },
  { name: 'Dr. Elena Ruiz', company: 'Bayview Medical', fax: '+1 (650) 555-0193', email: 'eruiz@bayviewmed.org', group: 'Medical' },
  { name: 'Hiroshi Tanaka', company: 'Kanto Freight', fax: '+81 3 5555 0121', email: 'h.tanaka@kantofreight.jp', group: 'Vendors' },
  { name: 'Lucia Moreau', company: 'Moreau & Fils', fax: '+33 1 55 55 01 22', email: 'lucia@moreau-fils.fr', group: 'Clients' },
  { name: 'Sam Okafor', company: 'State Records Office', fax: '+1 (916) 555-0155', email: 'records@state.ca.gov', group: 'Government' },
  { name: 'Ingrid Salvesen', company: 'Fjord Partners', fax: '+47 22 55 01 44', email: 'ingrid@fjordpartners.no', group: 'Clients' },
  { name: 'Derek Chan', company: 'Lumen Insurance', fax: '+1 (312) 555-0164', email: 'dchan@lumenins.com', group: 'Insurance' },
  { name: 'Amara Diallo', company: 'Westbridge University', fax: '+1 (617) 555-0132', email: 'a.diallo@westbridge.edu', group: 'Medical' },
];

const SEED_SUBJECTS = [
  { subject: 'Signed NDA — Acme Holdings', note: 'Please find the fully executed mutual non-disclosure agreement attached. Countersigned copies are filed with our legal team. Let me know if you need a wet-ink original.', docs: ['Mutual-NDA-Acme-signed.pdf'] },
  { subject: 'Purchase order #88120', note: 'Attached is purchase order 88120 for the March replenishment. Delivery window is the 14th through the 18th. Confirm receipt by return fax.', docs: ['PO-88120.pdf'] },
  { subject: 'Lab results — patient 4471', note: 'Confidential results for patient 4471. Reference range notes are on page 2. Please confirm the receiving physician has the chart open.', docs: ['Lab-4471.pdf'] },
  { subject: 'Invoice 2026-0417 — overdue notice', note: 'Our records show invoice 2026-0417 remains unpaid past terms. A duplicate is attached for your accounts payable team.', docs: ['Invoice-2026-0417.pdf'] },
  { subject: 'Insurance claim packet', note: 'Complete claim packet including adjuster notes and photographs of the damaged shipment.', docs: ['Claim-8842.pdf', 'Damage-photos.jpg'] },
  { subject: 'Court filing acknowledgment', note: 'Acknowledging receipt of the filing submitted on the 3rd. Please retain for your records.', docs: ['Filing-ack.pdf'] },
  { subject: 'Shipping manifest — container KF-2291', note: 'Manifest and customs declaration for container KF-2291, arriving Rotterdam on the 22nd.', docs: ['Manifest-KF-2291.pdf'] },
  { subject: 'Employment verification', note: 'Verification of employment for the named individual, signed by HR. This fax contains personal data — handle per policy.', docs: ['VOE-signed.pdf'] },
  { subject: 'Contract amendment #3', note: 'Amendment 3 covers the revised SLA credits and the extended term. Please sign and return the final page.', docs: ['Amendment-3.pdf'] },
  { subject: 'Medical records request', note: 'Records request with signed authorization attached. Please send the requested history to the number on file.', docs: ['ROI-authorization.pdf'] },
  { subject: 'Quarterly statement — Q4', note: 'Your quarterly statement is attached. No action is required unless a line item looks incorrect.', docs: ['Statement-Q4.pdf'] },
  { subject: 'Shipping exception notice', note: 'Carrier reported a delivery exception on the 9th. Reschedule instructions are attached.', docs: [] },
];

const INBOUND_SENDERS = [
  { name: 'Acme Holdings', number: '+1 (212) 555-0110' },
  { name: 'Bayview Medical', number: '+1 (650) 555-0193' },
  { name: 'State Records Office', number: '+1 (916) 555-0155' },
  { name: 'Lumen Insurance', number: '+1 (312) 555-0164' },
  { name: 'Kanto Freight', number: '+49 30 5555 0188' },
  { name: 'Westbridge University', number: '+1 (617) 555-0132' },
];

const INBOUND_SUBJECTS = [
  'Re: Signed NDA — countersigned copy',
  'Referral packet — new patient intake',
  'Updated remittance advice',
  'Request for records — case 22-1187',
  'Customs release confirmation',
  'Transcript request confirmation',
  'Revised schedule of fees',
  'Acknowledgment of service',
];

function seedFaxes() {
  const random = seededRandom(20261110);
  const current = readSettings();
  const contactsList = contacts.list();
  const numbersList = numbers.list();
  const items = [];

  // 34 outbound faxes across the last 30 days.
  for (let i = 0; i < 34; i += 1) {
    const template = SEED_SUBJECTS[i % SEED_SUBJECTS.length];
    const contact = contactsList[i % contactsList.length];
    const fromNumber = numbersList[i % numbersList.length] ?? numbersList[0];
    const daysAgo = Math.floor(random() * 29);
    const created = addDays(new Date(), -daysAgo);
    created.setUTCHours(8 + Math.floor(random() * 9), Math.floor(random() * 60), 0, 0);
    // Never seed a transmission in the future: "today" rows land in the past.
    if (created.getTime() > Date.now()) {
      created.setTime(Date.now() - (5 + Math.floor(random() * 600)) * 60_000);
    }
    const documents = template.docs.map((name) => ({
      id: `seed-${i}-${name}`,
      name,
      mime: 'application/pdf',
      sizeLabel: formatBytes(120_000 + Math.floor(random() * 900_000)),
      pages: 1 + Math.floor(random() * 4),
      kind: 'pdf',
    }));
    let pages = 1 + documents.reduce((sum, doc) => sum + doc.pages, 0);
    const quality = pick(['standard', 'standard', 'fine', 'ultra'], random);
    let status = 'delivered';
    let error = null;
    // Deterministic mix so the demo always exercises the failure UI.
    if (i % 11 === 5 && daysAgo > 0) {
      status = 'failed';
      error = pick(
        [
          { code: 'NO_ANSWER', message: 'The receiving fax machine did not answer after 4 attempts.' },
          { code: 'LINE_BUSY', message: 'The destination line stayed busy for the full retry window.' },
          { code: 'DOCUMENT_ERROR', message: 'The carrier rejected the document: unsupported page encoding.' },
        ],
        random,
      );
    } else if (daysAgo === 0 && random() > 0.86) {
      status = 'sending';
    }
    const durationSec = status === 'delivered' ? 18 + pages * 7 + Math.floor(random() * 20) : null;
    const rate = rateFor(quality);
    const cost = status === 'delivered' ? pages * rate : 0;
    const timeline = [
      { at: created.toISOString(), status: 'queued', label: 'Queued', detail: 'Accepted by Faxline' },
    ];
    if (status !== 'queued') {
      timeline.push({
        at: new Date(created.getTime() + 4000).toISOString(),
        status: 'sending',
        label: 'Transmitting',
        detail: `Connected to ${contact.fax}`,
      });
    }
    if (status === 'delivered') {
      timeline.push({
        at: new Date(created.getTime() + (durationSec || 30) * 1000).toISOString(),
        status: 'delivered',
        label: 'Delivered',
        detail: `${pages} page(s) confirmed by the receiving device`,
      });
    }
    if (status === 'failed') {
      timeline.push({
        at: new Date(created.getTime() + 90_000).toISOString(),
        status: 'failed',
        label: 'Failed',
        detail: error.message,
      });
    }

    const render = buildFaxRender({
      settings: { ...current, coverTemplate: current.coverTemplate },
      from: fromNumber.number,
      to: contact.fax,
      recipientName: contact.name,
      subject: template.subject,
      note: template.note,
      documents,
      createdAt: created.toISOString(),
    });
    pages = render.pageCount;

    items.push({
      direction: 'out',
      status,
      from_number: fromNumber.number,
      to_number: contact.fax,
      recipient_name: `${contact.name} · ${contact.company}`,
      subject: template.subject,
      note: template.note,
      pages,
      quality,
      created_at: created.toISOString(),
      completed_at:
        status === 'delivered' ? new Date(created.getTime() + (durationSec || 30) * 1000).toISOString() : null,
      duration_sec: durationSec,
      cost_cents: cost,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
      provider: 'simulator',
      provider_ref: `sim_${1000 + i}`,
      attempts: status === 'failed' ? 2 : 1,
      timeline,
      documents,
      render,
      tags: [template.subject.split(' ')[0].replace(/[^\w]/g, '')].filter(Boolean),
      read: true,
    });
  }

  // Inbound faxes.
  for (let i = 0; i < 14; i += 1) {
    const sender = INBOUND_SENDERS[i % INBOUND_SENDERS.length];
    const subject = INBOUND_SUBJECTS[i % INBOUND_SUBJECTS.length];
    const toNumber = numbersList[0];
    const daysAgo = Math.floor(random() * 24);
    const created = addDays(new Date(), -daysAgo);
    created.setUTCHours(9 + Math.floor(random() * 8), Math.floor(random() * 60), 0, 0);
    const bodyPages = 1 + Math.floor(random() * 4);
    const unread = i < 4;
    const render = buildFaxRender({
      settings: current,
      from: sender.number,
      to: toNumber.number,
      recipientName: `${current.workspaceName} · Fax desk`,
      subject,
      note: `Inbound fax received on ${toNumber.number}. ${bodyPages} page(s) captured at 200 dpi, fine resolution.`,
      documents: [
        {
          id: `seed-in-${i}`,
          name: `${sender.name} — ${subject}.pdf`,
          pages: bodyPages,
          sizeLabel: formatBytes(140_000 + Math.floor(random() * 600_000)),
          kind: 'pdf',
        },
      ],
      createdAt: created.toISOString(),
      direction: 'in',
    });
    const pages = render.pageCount;
    items.push({
      direction: 'in',
      status: 'received',
      from_number: sender.number,
      to_number: toNumber.number,
      recipient_name: sender.name,
      subject,
      note: '',
      pages,
      quality: 'fine',
      created_at: created.toISOString(),
      completed_at: created.toISOString(),
      duration_sec: 12 + pages * 6,
      cost_cents: 0,
      provider: 'simulator',
      provider_ref: `sim_in_${2000 + i}`,
      attempts: 1,
      timeline: [
        { at: created.toISOString(), status: 'received', label: 'Received', detail: `${pages} page(s) from ${sender.number}` },
      ],
      documents: [],
      render,
      tags: ['Inbound'],
      read: !unread,
      starred: i === 1,
    });
  }

  // A scheduled fax due later today.
  const scheduled = addDays(new Date(), 0);
  scheduled.setUTCHours(17, 45, 0, 0);
  if (scheduled.getTime() < Date.now()) scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  const scheduledContact = contactsList[0];
  items.push({
    direction: 'out',
    status: 'scheduled',
    from_number: numbersList[0].number,
    to_number: scheduledContact.fax,
    recipient_name: `${scheduledContact.name} · ${scheduledContact.company}`,
    subject: 'Weekly compliance packet',
    note: 'Scheduled weekly transmission of the compliance packet. Automatically retries up to three times during business hours.',
    pages: 4,
    // overwritten by the page count of the rendered packet below
    quality: 'fine',
    scheduled_at: scheduled.toISOString(),
    created_at: nowIso(),
    cost_cents: 0,
    provider: 'simulator',
    attempts: 0,
    timeline: [{ at: nowIso(), status: 'scheduled', label: 'Scheduled', detail: `Queued for ${scheduled.toISOString()}` }],
    documents: [],
    render: buildFaxRender({
      settings: current,
      from: numbersList[0].number,
      to: scheduledContact.fax,
      recipientName: scheduledContact.name,
      subject: 'Weekly compliance packet',
      note: 'Scheduled weekly transmission of the compliance packet.',
      documents: [
        { id: 'seed-sched-1', name: 'Compliance-packet.pdf', pages: 3, sizeLabel: '412 KB', kind: 'pdf' },
      ],
      createdAt: nowIso(),
    }),
    tags: ['Scheduled'],
    read: true,
  });

  for (const item of items) faxes.insert(item);
}

export function seedDemo() {
  db.exec('DELETE FROM faxes; DELETE FROM contacts; DELETE FROM numbers; DELETE FROM events; DELETE FROM deliveries;');
  db.exec('DELETE FROM settings');
  settings.ensureDefaults();

  const insertedNumbers = SEED_NUMBERS.map((entry) =>
    numbers.insert({
      number: entry.number,
      label: entry.label,
      region: entry.region,
      country: entry.region.slice(0, 2),
      monthly_cents: entry.monthly,
      is_default: !!entry.isDefault,
    }),
  );
  // Reflect the seeded inbound volume without faking it through real fax rows.
  SEED_NUMBERS.forEach((entry, index) => {
    db.prepare('UPDATE numbers SET inbound_count = ? WHERE id = ?').run(entry.inbound, insertedNumbers[index].id);
  });

  for (const entry of SEED_CONTACTS) {
    contacts.insert({
      name: entry.name,
      company: entry.company,
      fax: entry.fax,
      email: entry.email,
      group_name: entry.group,
      favorite: entry.favorite,
    });
  }

  settings.update({
    defaultNumberId: insertedNumbers[0].id,
    workspaceName: DEFAULT_SETTINGS.workspaceName,
    coverHeader: DEFAULT_SETTINGS.coverHeader,
    senderName: DEFAULT_SETTINGS.senderName,
  });

  seedFaxes();

  events.log({ type: 'workspace.ready', message: 'Workspace initialized with a 30-day demo history.' });
  events.log({ type: 'number.provisioned', message: `${insertedNumbers.length} fax numbers are active.` });
  return true;
}

export function isSeeded() {
  return faxes.count() > 0;
}

export function resetDemo() {
  return seedDemo();
}

export const store = {
  settings,
  numbers,
  contacts,
  faxes,
  files,
  events,
  keys,
  deliveries,
  stats,
  rateFor,
  isSeeded,
  resetDemo,
};
