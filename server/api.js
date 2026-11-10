import crypto from 'node:crypto';
import {
  formatBytes,
  isEmail,
  isHttpUrl,
  isValidFaxNumber,
  normalizeFaxNumber,
  nowIso,
  parseJson,
  sha256,
  timingSafeEqual,
  uid,
} from './util.js';
import { store } from './store.js';
import { buildFaxRender, pageToSvg, renderFaxPdf } from './render.js';
import { providerStatus, estimateCost } from './providers.js';
import {
  cancelFax,
  dispatch,
  engineSummary,
  priceFor,
  retryFax,
  setForceFail,
  simulateInbound,
} from './engine.js';
import { broadcast, clientCount } from './hub.js';
import { deliverWebhook } from './webhooks.js';

const MAX_JSON_BODY = 1_000_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const QUALITIES = ['standard', 'fine', 'ultra'];
const API_KEY_SCOPES = ['read', 'write'];

class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

function readRaw(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body exceeds ${formatBytes(limit)}.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const BODY_CACHE = Symbol('faxline.body');

async function readJson(req) {
  // The dispatcher parses JSON bodies once; handlers may read the same request
  // again, and a consumed stream would otherwise never emit 'end' a second time.
  if (req[BODY_CACHE] !== undefined) return req[BODY_CACHE];
  const raw = await readRaw(req);
  if (!raw.length) {
    req[BODY_CACHE] = {};
    return req[BODY_CACHE];
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Expected a JSON object body.');
    }
    req[BODY_CACHE] = parsed;
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Malformed JSON body.');
  }
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    let chunk = buffer.subarray(start, next);
    if (chunk[0] === 13 && chunk[1] === 10) chunk = chunk.subarray(2);
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) {
      chunk = chunk.subarray(0, chunk.length - 2);
    }
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = chunk.subarray(0, headerEnd).toString('utf8');
      const content = chunk.subarray(headerEnd + 4);
      parts.push({
        name: /name="([^"]*)"/i.exec(headerText)?.[1] ?? '',
        filename: /filename="([^"]*)"/i.exec(headerText)?.[1] ?? null,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream',
        content,
      });
    }
    cursor = next;
  }
  return parts;
}

function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? Math.max(1, matches.length) : 1;
}

function requireString(value, label, { max = 400, min = 1, required = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (required) throw new HttpError(422, `${label} is required.`);
    return '';
  }
  if (text.length < min) throw new HttpError(422, `${label} must be at least ${min} characters.`);
  if (text.length > max) throw new HttpError(422, `${label} must be ${max} characters or fewer.`);
  return text;
}

function clampList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((entry) => String(entry)).filter(Boolean);
}

function requireNumber(value) {
  const number = store.numbers.get(String(value || ''));
  if (!number) throw new HttpError(422, 'Select a sending fax number.');
  if (!number.capabilities.includes('send')) throw new HttpError(422, 'That number cannot send faxes.');
  return number;
}

function normalizeDocuments(documentIds) {
  const ids = clampList(documentIds).slice(0, 10);
  const documents = [];
  for (const id of ids) {
    const file = store.files.get(id);
    if (!file) throw new HttpError(422, `Attachment ${id} no longer exists. Upload it again.`);
    documents.push({
      id: file.id,
      name: file.name,
      mime: file.mime,
      sizeLabel: formatBytes(file.size),
      pages: file.pages,
      kind: file.kind,
    });
  }
  return documents;
}

function renderFor(input, settings = store.settings.get()) {
  const documents = input.documents || [];
  return buildFaxRender({
    settings: { ...settings, ...(input.settings || {}) },
    from: input.from,
    to: input.to,
    recipientName: input.recipientName,
    subject: input.subject,
    note: input.note,
    documents,
    createdAt: input.createdAt || nowIso(),
    direction: input.direction || 'out',
  });
}

function faxPayload(fax) {
  if (!fax) return null;
  return { ...fax, pages: fax.pages, costLabel: `$${(fax.cost_cents / 100).toFixed(2)}` };
}

async function authenticate(req) {
  const header = String(req.headers.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : String(req.headers['x-api-key'] || '').trim();
  if (!token) return null;
  const record = store.keys.findByHash(sha256(token));
  if (!record) return null;
  store.keys.touch(record.id);
  return record;
}

/* ------------------------------------------------------------------- routes */

const route = (method, pattern, handler, options = {}) => ({
  method,
  matcher: new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}/?$`),
  paramNames: Array.from(pattern.matchAll(/:([a-zA-Z]+)/g)).map((m) => m[1]),
  handler,
  options,
});

const routes = [
  route('GET', '/api/health', () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    provider: providerStatus().active,
    streamClients: clientCount(),
    engine: engineSummary(),
  })),

  route('GET', '/api/bootstrap', () => {
    const settings = store.settings.get();
    const recent = store.faxes.list({ limit: 24 });
    const stats = store.stats(30);
    const unread = store.faxes.count({ direction: 'in', read: 0 });
    return {
      settings,
      numbers: store.numbers.list(),
      contacts: store.contacts.list(),
      faxes: recent.items,
      faxTotal: recent.total,
      stats,
      events: store.events.list(18),
      deliveries: store.deliveries.list(10),
      provider: providerStatus(),
      engine: engineSummary(),
      counts: {
        unread,
        queued: store.faxes.count({ status: 'queued' }),
        failed: store.faxes.count({ status: 'failed' }),
        scheduled: store.faxes.count({ status: 'scheduled' }),
      },
      generatedAt: nowIso(),
    };
  }),

  route('GET', '/api/stats', ({ query }) => store.stats(Math.min(90, Math.max(1, Number(query.get('range')) || 30)))),

  route('GET', '/api/faxes', ({ query }) =>
    store.faxes.list({
      direction: query.get('direction') || 'all',
      status: query.get('status') || 'all',
      search: (query.get('search') || '').trim(),
      starred: query.get('starred') === 'true',
      unread: query.get('unread') === 'true',
      sort: query.get('sort') || 'newest',
      limit: Number(query.get('limit')) || 50,
      offset: Number(query.get('offset')) || 0,
    }),
  ),

  route('GET', '/api/faxes/:id', ({ params }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    return { fax: faxPayload(fax) };
  }),

  route('POST', '/api/faxes', async ({ req }) => {
    const body = await readJson(req);
    const settings = store.settings.get();
    const from = requireNumber(body.fromNumberId || settings.defaultNumberId || store.numbers.default()?.id);
    const to = normalizeFaxNumber(requireString(body.to, 'Recipient fax number', { max: 40 }));
    if (!isValidFaxNumber(to)) throw new HttpError(422, 'Enter a valid fax number (8–15 digits).');
    const subject = requireString(body.subject, 'Subject', { max: 120 });
    const note = requireString(body.note, 'Cover message', { max: 4000, required: false });
    const quality = QUALITIES.includes(body.quality) ? body.quality : 'standard';
    const documents = normalizeDocuments(body.documentIds);
    let scheduledAt = null;
    if (body.scheduledAt) {
      const when = new Date(body.scheduledAt);
      if (Number.isNaN(when.getTime())) throw new HttpError(422, 'Scheduled time is not a valid date.');
      if (when.getTime() < Date.now() - 60_000) throw new HttpError(422, 'Scheduled time must be in the future.');
      scheduledAt = when.toISOString();
    }
    const contact = store.contacts.findByFax(to);
    const recipientName =
      requireString(body.recipientName, 'Recipient name', { max: 120, required: false }) ||
      (contact ? `${contact.name} · ${contact.company}` : 'Unnamed recipient');

    const render = renderFor({ from: from.number, to, recipientName, subject, note, documents });
    const pages = render.pageCount;
    const fax = store.faxes.insert({
      direction: 'out',
      status: scheduledAt ? 'scheduled' : 'queued',
      from_number: from.number,
      to_number: to,
      recipient_name: recipientName,
      subject,
      note,
      pages,
      quality,
      scheduled_at: scheduledAt,
      documents,
      render,
      tags: clampList(body.tags).slice(0, 6),
      priority: ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal',
      max_attempts: Math.min(5, Math.max(1, Number(body.maxAttempts) || 3)),
      cost_cents: 0,
      cover_template: settings.coverTemplate,
      timeline: [
        {
          at: nowIso(),
          status: scheduledAt ? 'scheduled' : 'queued',
          label: scheduledAt ? 'Scheduled' : 'Queued',
          detail: scheduledAt ? `Scheduled for ${scheduledAt}` : 'Accepted by Telno Faxline',
        },
      ],
    });

    store.events.log({
      type: scheduledAt ? 'fax.scheduled' : 'fax.queued',
      faxId: fax.id,
      message: `${subject} → ${to} (${pages} page${pages === 1 ? '' : 's'})`,
    });
    if (contact) store.contacts.touch(contact.id);
    broadcast('fax.created', { fax: store.faxes.get(fax.id) });
    broadcast('stats.stale', { at: nowIso() });

    const dispatched = await dispatch(fax.id);
    return { fax: faxPayload(dispatched || store.faxes.get(fax.id)) };
  }, { status: 201 }),

  route('POST', '/api/faxes/:id/retry', async ({ params }) => {
    const fax = await retryFax(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    return { fax: faxPayload(store.faxes.get(params.id)) };
  }),

  route('POST', '/api/faxes/:id/cancel', async ({ params }) => {
    const fax = await cancelFax(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    return { fax: faxPayload(fax) };
  }),

  route('POST', '/api/faxes/:id/star', ({ params, body }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    const next = store.faxes.update(fax.id, { starred: body.starred === undefined ? !fax.starred : !!body.starred });
    broadcast('fax.updated', { fax: next });
    return { fax: faxPayload(next) };
  }),

  route('POST', '/api/faxes/:id/read', ({ params }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    const next = store.faxes.update(fax.id, { read: true });
    broadcast('fax.updated', { fax: next });
    broadcast('counts.stale', {});
    return { fax: faxPayload(next) };
  }),

  route('DELETE', '/api/faxes/:id', ({ params }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    store.faxes.remove(fax.id);
    store.events.log({ type: 'fax.deleted', faxId: null, message: `Deleted fax ${fax.subject || fax.id}` });
    broadcast('fax.deleted', { id: fax.id });
    broadcast('stats.stale', { at: nowIso() });
    return { deleted: true, id: fax.id };
  }),

  route('GET', '/api/faxes/:id/pages', ({ params }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    const render =
      fax.render ||
      renderFor({
        from: fax.from_number,
        to: fax.to_number,
        recipientName: fax.recipient_name,
        subject: fax.subject,
        note: fax.note,
        documents: fax.documents,
        createdAt: fax.created_at,
        direction: fax.direction,
      });
    return {
      pages: render.pages.map((page, index) => ({ index, kind: page.kind, label: page.label })),
      pageCount: render.pageCount,
    };
  }),

  route('GET', '/api/faxes/:id/page/:index.svg', ({ params, res }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    const render =
      fax.render ||
      renderFor({
        from: fax.from_number,
        to: fax.to_number,
        recipientName: fax.recipient_name,
        subject: fax.subject,
        note: fax.note,
        documents: fax.documents,
        createdAt: fax.created_at,
        direction: fax.direction,
      });
    const page = render.pages[Number(params.index)];
    if (!page) throw new HttpError(404, 'Page not found.');
    const svg = pageToSvg(page, { width: 612 });
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(svg);
    return undefined;
  }),

  route('GET', '/api/faxes/:id/pdf', ({ params, res }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    const render =
      fax.render ||
      renderFor({
        from: fax.from_number,
        to: fax.to_number,
        recipientName: fax.recipient_name,
        subject: fax.subject,
        note: fax.note,
        documents: fax.documents,
        createdAt: fax.created_at,
        direction: fax.direction,
      });
    const pdf = renderFaxPdf(render.pages, { title: fax.subject, createdAt: fax.created_at });
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="fax-${fax.id}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
    return undefined;
  }),

  route('POST', '/api/preview', async ({ req }) => {
    const body = await readJson(req);
    const settings = store.settings.get();
    const documents = normalizeDocuments(body.documentIds);
    // The settings editor previews unsaved artwork by passing partial overrides.
    const overrides = {};
    if (['minimal', 'classic', 'branded'].includes(body.template)) overrides.coverTemplate = body.template;
    if (body.cover && typeof body.cover === 'object') {
      const cover = body.cover;
      if (/^#[0-9a-fA-F]{6}$/.test(String(cover.accent || ''))) overrides.accent = cover.accent;
      if (typeof cover.coverHeader === 'string') overrides.coverHeader = cover.coverHeader.slice(0, 60);
      if (typeof cover.coverFooter === 'string') overrides.coverFooter = cover.coverFooter.slice(0, 320);
      if (typeof cover.showPageNumbers === 'boolean') overrides.showPageNumbers = cover.showPageNumbers;
      if (typeof cover.senderName === 'string') overrides.senderName = cover.senderName.slice(0, 80);
    }
    const render = renderFor(
      {
        from: body.from || store.numbers.default()?.number || '',
        to: normalizeFaxNumber(body.to || ''),
        recipientName: body.recipientName || 'Unnamed recipient',
        subject: body.subject || '',
        note: body.note || '',
        documents,
        direction: 'out',
        settings: overrides,
      },
      settings,
    );
    const pages = render.pages.map((page, index) => ({
      index,
      kind: page.kind,
      label: page.label,
      svg: pageToSvg(page, { width: 420 }),
    }));
    return {
      pages,
      pageCount: render.pageCount,
      cost: estimateCost(render.pageCount, body.quality || 'standard'),
    };
  }),

  route('POST', '/api/uploads', async ({ req }) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      throw new HttpError(415, 'Uploads must use multipart/form-data.');
    }
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!boundary) throw new HttpError(400, 'Missing multipart boundary.');
    const raw = await readRaw(req, MAX_UPLOAD_BYTES);
    const parts = parseMultipart(raw, boundary[1] || boundary[2]);
    const accepted = [];
    for (const part of parts) {
      if (!part.filename || !part.content.length) continue;
      const mime = part.contentType.split(';')[0].trim().toLowerCase();
      const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(part.filename);
      const isImage = mime.startsWith('image/');
      if (!isPdf && !isImage) {
        throw new HttpError(415, `Unsupported file type: ${part.filename}. Upload PDF or image documents.`);
      }
      const pages = isPdf ? countPdfPages(part.content) : 1;
      const saved = store.files.save(part.content, { name: part.filename, mime, pages });
      accepted.push(saved);
      if (accepted.length >= 10) break;
    }
    if (!accepted.length) throw new HttpError(422, 'No files were found in the upload.');
    store.events.log({ type: 'document.uploaded', message: `${accepted.length} document(s) uploaded.` });
    return { documents: accepted };
  }),

  route('GET', '/api/files/:id', ({ params, res }) => {
    const file = store.files.read(params.id);
    if (!file) throw new HttpError(404, 'File not found.');
    res.writeHead(200, {
      'Content-Type': file.meta.mime || 'application/octet-stream',
      'Content-Length': file.buffer.length,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.meta.name)}"`,
      'Cache-Control': 'private, max-age=600',
    });
    res.end(file.buffer);
    return undefined;
  }),

  /* ------------------------------------------------------------- contacts */

  route('GET', '/api/contacts', () => ({ contacts: store.contacts.list() })),

  route('POST', '/api/contacts', async ({ req }) => {
    const body = await readJson(req);
    const name = requireString(body.name, 'Contact name', { max: 120 });
    const fax = normalizeFaxNumber(requireString(body.fax, 'Fax number', { max: 40 }));
    if (!isValidFaxNumber(fax)) throw new HttpError(422, 'Enter a valid fax number.');
    if (body.email && !isEmail(body.email)) throw new HttpError(422, 'Enter a valid email address.');
    const contact = store.contacts.insert({
      name,
      company: requireString(body.company, 'Company', { max: 120, required: false }),
      fax,
      email: requireString(body.email, 'Email', { max: 160, required: false }),
      group_name: requireString(body.group, 'Group', { max: 60, required: false }) || 'General',
      favorite: !!body.favorite,
      notes: requireString(body.notes, 'Notes', { max: 1000, required: false }),
    });
    store.events.log({ type: 'contact.created', message: `Added ${contact.name} (${contact.fax}).` });
    broadcast('contacts.stale', {});
    return { contact };
  }, { status: 201 }),

  route('PATCH', '/api/contacts/:id', async ({ params, req }) => {
    const body = await readJson(req);
    const patch = {};
    if (body.name !== undefined) patch.name = requireString(body.name, 'Contact name', { max: 120 });
    if (body.fax !== undefined) {
      const fax = normalizeFaxNumber(requireString(body.fax, 'Fax number', { max: 40 }));
      if (!isValidFaxNumber(fax)) throw new HttpError(422, 'Enter a valid fax number.');
      patch.fax = fax;
    }
    if (body.email !== undefined) {
      if (body.email && !isEmail(body.email)) throw new HttpError(422, 'Enter a valid email address.');
      patch.email = String(body.email || '');
    }
    if (body.company !== undefined) patch.company = String(body.company || '').slice(0, 120);
    if (body.group !== undefined) patch.group_name = String(body.group || 'General').slice(0, 60);
    if (body.notes !== undefined) patch.notes = String(body.notes || '').slice(0, 1000);
    if (body.favorite !== undefined) patch.favorite = !!body.favorite;
    const contact = store.contacts.update(params.id, patch);
    if (!contact) throw new HttpError(404, 'Contact not found.');
    broadcast('contacts.stale', {});
    return { contact };
  }),

  route('DELETE', '/api/contacts/:id', ({ params }) => {
    if (!store.contacts.get(params.id)) throw new HttpError(404, 'Contact not found.');
    store.contacts.remove(params.id);
    broadcast('contacts.stale', {});
    return { deleted: true };
  }),

  /* -------------------------------------------------------------- numbers */

  route('GET', '/api/numbers', () => ({ numbers: store.numbers.list() })),

  route('POST', '/api/numbers', async ({ req }) => {
    const body = await readJson(req);
    const number = normalizeFaxNumber(requireString(body.number, 'Fax number', { max: 40 }));
    if (!isValidFaxNumber(number)) throw new HttpError(422, 'Enter a valid fax number to provision.');
    if (store.numbers.list().some((entry) => entry.number === number)) {
      throw new HttpError(409, 'That number is already provisioned.');
    }
    const created = store.numbers.insert({
      number,
      label: requireString(body.label, 'Label', { max: 80, required: false }) || 'New number',
      region: requireString(body.region, 'Region', { max: 20, required: false }) || 'US',
      country: (requireString(body.region, 'Region', { max: 20, required: false }) || 'US').slice(0, 2),
      capabilities: clampList(body.capabilities).length ? clampList(body.capabilities) : ['send', 'receive'],
      monthly_cents: Number(body.monthly_cents) || 495,
    });
    store.events.log({ type: 'number.provisioned', message: `Provisioned ${created.number}.` });
    broadcast('numbers.stale', {});
    return { number: created };
  }, { status: 201 }),

  route('PATCH', '/api/numbers/:id', async ({ params, req }) => {
    const body = await readJson(req);
    const patch = {};
    if (body.label !== undefined) patch.label = String(body.label || '').slice(0, 80);
    if (body.region !== undefined) patch.region = String(body.region || '').slice(0, 20);
    if (body.status !== undefined) patch.status = body.status === 'paused' ? 'paused' : 'active';
    if (body.capabilities !== undefined) patch.capabilities = clampList(body.capabilities);
    if (body.monthly_cents !== undefined) patch.monthly_cents = Number(body.monthly_cents) || 0;
    if (body.is_default !== undefined) patch.is_default = !!body.is_default;
    const updated = store.numbers.update(params.id, patch);
    if (!updated) throw new HttpError(404, 'Number not found.');
    broadcast('numbers.stale', {});
    return { number: updated };
  }),

  route('DELETE', '/api/numbers/:id', ({ params }) => {
    const number = store.numbers.get(params.id);
    if (!number) throw new HttpError(404, 'Number not found.');
    if (number.is_default) throw new HttpError(422, 'Choose a different default number before releasing this one.');
    store.numbers.remove(params.id);
    store.events.log({ type: 'number.released', message: `Released ${number.number}.` });
    broadcast('numbers.stale', {});
    return { deleted: true };
  }),

  /* --------------------------------------------------------------- events */

  route('GET', '/api/events', ({ query }) => ({
    events: store.events.list(Number(query.get('limit')) || 40),
  })),

  route('GET', '/api/deliveries', () => ({ deliveries: store.deliveries.list(20) })),

  /* ----------------------------------------------------------------- keys */

  route('GET', '/api/keys', () => ({ keys: store.keys.list() })),

  route('POST', '/api/keys', async ({ req }) => {
    const body = await readJson(req);
    const name = requireString(body.name, 'Key name', { max: 60, required: false }) || 'Untitled key';
    const secret = `fx_live_${uid('k').replace('k_', '')}${uid('k').slice(2, 6)}`;
    const record = store.keys.insert({
      name,
      hash: sha256(secret),
      prefix: secret.slice(0, 14),
      scopes: clampList(body.scopes).filter((scope) => API_KEY_SCOPES.includes(scope)).length
        ? clampList(body.scopes).filter((scope) => API_KEY_SCOPES.includes(scope))
        : API_KEY_SCOPES,
    });
    store.events.log({ type: 'key.created', message: `API key “${name}” created.` });
    return { key: secret, apiKey: { ...record, hash: undefined } };
  }, { status: 201 }),

  route('DELETE', '/api/keys/:id', ({ params }) => {
    store.keys.revoke(params.id);
    store.events.log({ type: 'key.revoked', level: 'warn', message: 'API key revoked.' });
    return { revoked: true };
  }),

  /* -------------------------------------------------------------- settings */

  route('PATCH', '/api/settings', async ({ req }) => {
    const body = await readJson(req);
    if (body.webhookUrl && !isHttpUrl(body.webhookUrl)) {
      throw new HttpError(422, 'Webhook URL must be a valid http(s) address.');
    }
    if (body.accent && !/^#[0-9a-fA-F]{6}$/.test(String(body.accent))) {
      throw new HttpError(422, 'Accent colour must be a hex value such as #757cf2.');
    }
    const patch = {};
    const passthrough = [
      'workspaceName',
      'userName',
      'userRole',
      'userEmail',
      'timezone',
      'senderName',
      'defaultNumberId',
      'coverTemplate',
      'accent',
      'coverHeader',
      'coverFooter',
      'theme',
      'density',
      'webhookUrl',
    ];
    for (const key of passthrough) if (body[key] !== undefined) patch[key] = body[key];
    for (const key of ['showPageNumbers', 'notifyDelivered', 'notifyFailed', 'dailyDigest']) {
      if (body[key] !== undefined) patch[key] = !!body[key];
    }
    if (body.retentionDays !== undefined) patch.retentionDays = Math.min(3650, Math.max(1, Number(body.retentionDays) || 90));
    if (body.webhookEvents !== undefined) patch.webhookEvents = clampList(body.webhookEvents);
    const settings = store.settings.update(patch);
    broadcast('settings.updated', { settings });
    return { settings };
  }),

  /* -------------------------------------------------------------- dev tools */

  route('POST', '/api/dev/simulate-inbound', async ({ req }) => {
    const body = await readJson(req).catch(() => ({}));
    const fax = simulateInbound({ numberId: body.numberId || null });
    void deliverWebhook('fax.received', fax);
    return { fax: faxPayload(fax) };
  }),

  route('POST', '/api/dev/fail-next', async ({ req }) => {
    const body = await readJson(req).catch(() => ({}));
    return { forceFail: setForceFail(body.enabled !== false) };
  }),

  route('POST', '/api/dev/reset', () => {
    store.resetDemo();
    broadcast('workspace.reset', { at: nowIso() });
    return { reset: true };
  }),

  /* ---------------------------------------------------- provider callbacks */

  route('POST', '/api/webhooks/provider', async ({ req }) => {
    const raw = await readRaw(req, 2_000_000);
    const settings = store.settings.get();
    const secret = process.env.FAX_WEBHOOK_SECRET || settings.webhookSecret;
    if (secret) {
      const signature = String(req.headers['x-faxline-signature'] || '')
        .replace(/^sha256=/, '')
        .trim();
      if (!signature || !timingSafeEqual(signature, sha256Hmac(secret, raw))) {
        throw new HttpError(401, 'Webhook signature did not match.');
      }
    }
    let payload = {};
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'Malformed webhook body.');
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const providerRef = data.providerRef || data.id || payload.providerRef || null;
    const rawStatus = String(data.status || payload.status || '').toLowerCase();
    const statusMap = {
      delivered: 'delivered',
      success: 'delivered',
      failed: 'failed',
      failure: 'failed',
      error: 'failed',
      canceled: 'cancelled',
      cancelled: 'cancelled',
      queued: 'sending',
      sending: 'sending',
      sent: 'sending',
      pending: 'sending',
      received: 'received',
    };
    const status = statusMap[rawStatus];
    if (!status) throw new HttpError(422, `Unsupported provider status: ${rawStatus || '(missing)'}`);
    const fax = (data.faxId && store.faxes.get(String(data.faxId))) || (providerRef && store.faxes.byProviderRef(providerRef));
    if (!fax) throw new HttpError(404, 'No fax matches that provider reference.');

    const patch = {
      status,
      timeline: [
        ...(fax.timeline || []),
        {
          at: nowIso(),
          status,
          label:
            status === 'delivered'
              ? 'Delivered'
              : status === 'failed'
                ? 'Failed'
                : status === 'cancelled'
                  ? 'Cancelled'
                  : 'Provider update',
          detail: data.errorMessage || data.error?.message || `Provider reported ${rawStatus}`,
        },
      ],
    };
    if (status === 'delivered') {
      patch.completed_at = nowIso();
      patch.duration_sec = Number(data.durationSec) || fax.duration_sec || null;
      patch.cost_cents = Number(data.costCents) || priceFor(fax.pages, fax.quality);
      patch.error_code = null;
      patch.error_message = null;
    }
    if (status === 'failed') {
      patch.completed_at = nowIso();
      patch.error_code = data.errorCode || 'PROVIDER_ERROR';
      patch.error_message = data.errorMessage || data.error?.message || 'The provider reported a failure.';
      patch.cost_cents = 0;
    }
    const updated = store.faxes.update(fax.id, patch);
    store.events.log({
      type: `fax.${status}`,
      level: status === 'failed' ? 'error' : 'info',
      faxId: fax.id,
      message: `Provider update: ${fax.subject} → ${status}`,
    });
    broadcast('fax.updated', { fax: updated });
    broadcast('stats.stale', { at: nowIso() });
    void deliverWebhook(`fax.${status}`, updated);
    return { received: true, faxId: fax.id, status };
  }),

  /* ----------------------------------------------------------- public API v1 */

  route('GET', '/api/v1/faxes', ({ query }) => {
    const result = store.faxes.list({
      direction: query.get('direction') || 'all',
      status: query.get('status') || 'all',
      search: query.get('search') || '',
      limit: Number(query.get('limit')) || 25,
      offset: Number(query.get('offset')) || 0,
    });
    return { data: result.items.map((fax) => publicFax(fax)), hasMore: result.total > result.items.length };
  }, { apiKey: true }),

  route('GET', '/api/v1/faxes/:id', ({ params }) => {
    const fax = store.faxes.get(params.id);
    if (!fax) throw new HttpError(404, 'Fax not found.');
    return { data: publicFax(fax) };
  }, { apiKey: true }),

  route('POST', '/api/v1/faxes', async ({ req }) => {
    const body = await readJson(req);
    const settings = store.settings.get();
    const from = requireNumber(body.fromNumberId || body.from || settings.defaultNumberId);
    const to = normalizeFaxNumber(requireString(body.to, 'Recipient fax number', { max: 40 }));
    if (!isValidFaxNumber(to)) throw new HttpError(422, 'Enter a valid fax number.');
    const subject = requireString(body.subject, 'Subject', { max: 120 });
    const note = requireString(body.note, 'Cover message', { max: 4000, required: false });
    const documents = normalizeDocuments(body.documentIds);
    const recipientName =
      requireString(body.recipientName, 'Recipient name', { max: 120, required: false }) || 'API recipient';
    const render = renderFor({ from: from.number, to, recipientName, subject, note, documents });
    const fax = store.faxes.insert({
      direction: 'out',
      status: 'queued',
      from_number: from.number,
      to_number: to,
      recipient_name: recipientName,
      subject,
      note,
      pages: render.pageCount,
      quality: QUALITIES.includes(body.quality) ? body.quality : 'standard',
      documents,
      render,
      provider: providerStatus().active,
      timeline: [{ at: nowIso(), status: 'queued', label: 'Queued', detail: 'Accepted via API' }],
    });
    store.events.log({ type: 'fax.queued', faxId: fax.id, message: `API: ${subject} → ${to}` });
    await dispatch(fax.id);
    return { data: publicFax(store.faxes.get(fax.id)) };
  }, { apiKey: true, status: 201 }),

  route('GET', '/api/v1/numbers', () => ({ data: store.numbers.list() }), { apiKey: true }),
];

const sha256Hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

function publicFax(fax) {
  return {
    id: fax.id,
    direction: fax.direction,
    status: fax.status,
    from: fax.from_number,
    to: fax.to_number,
    recipientName: fax.recipient_name,
    subject: fax.subject,
    pages: fax.pages,
    quality: fax.quality,
    createdAt: fax.created_at,
    completedAt: fax.completed_at,
    costCents: fax.cost_cents,
    errorCode: fax.error_code,
    errorMessage: fax.error_message,
    providerRef: fax.provider_ref,
  };
}

export async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/stream') {
    const { subscribe } = await import('./hub.js');
    subscribe(req, res);
    return true;
  }

  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = entry.matcher.exec(pathname);
    if (!match) continue;
    const params = {};
    entry.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    try {
      if (entry.options.apiKey) {
        const key = await authenticate(req);
        if (!key) {
          sendJson(res, 401, { error: 'A valid API key is required. Send Authorization: Bearer fx_live_…' });
          return true;
        }
        const scope = method === 'GET' ? 'read' : 'write';
        const scopes = parseJson(key.scopes, ['read', 'write']);
        if (!scopes.includes(scope)) {
          sendJson(res, 403, { error: `This key is missing the "${scope}" scope.` });
          return true;
        }
      }
      let body = {};
      if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
        const contentType = String(req.headers['content-type'] || '');
        if (contentType.includes('application/json') && !pathname.startsWith('/api/uploads') && pathname !== '/api/webhooks/provider') {
          body = await readJson(req);
        }
      }
      const result = await entry.handler({ req, res, url, query: url.searchParams, params, body });
      if (res.headersSent) return true;
      sendJson(res, entry.options.status || 200, result ?? { ok: true });
      return true;
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* stream already closed */
        }
        return true;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error(`[api] ${method} ${pathname} failed:`, error);
      sendJson(res, status, {
        error: error?.message || 'Unexpected server error.',
        details: error instanceof HttpError ? error.details : null,
      });
      return true;
    }
  }
  sendJson(res, 404, { error: `No API route matches ${method} ${pathname}.` });
  return true;
}

export { HttpError };
