/**
 * End-to-end API tests.
 *
 * Boots the real server as a child process on an ephemeral port with its
 * working directory pointed at a throwaway folder, so `node:sqlite` creates a
 * fresh demo database there and never touches the local workspace data.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telno-faxline-test-'));
const logs = [];

let port = 0;
let child = null;
let seeded = null;
let createdFaxId = null;

const base = () => `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${base()}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(150);
  }
  throw new Error(`server did not become healthy in ${timeoutMs}ms\n${logs.join('')}`);
}

async function request(method, urlPath, { json, raw, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (raw !== undefined) init.body = raw;
  if (form !== undefined) init.body = form;
  const res = await fetch(base() + urlPath, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body, text };
}

async function bytes(urlPath) {
  const res = await fetch(base() + urlPath);
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

// Earlier tests leave simulated transmissions in flight. The failure flag is
// consumed by whichever fax settles first, so wait for the engine to go quiet
// before arming it.
async function waitForEngineIdle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await request('GET', '/api/health');
    if (health.body?.engine?.timers === 0) return;
    await sleep(100);
  }
  throw new Error('delivery engine never went idle');
}

async function waitForFax(id, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request('GET', `/api/faxes/${id}`);
    last = res.body?.fax ?? null;
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`fax ${id} never matched the expected state; last seen ${JSON.stringify(last)}`);
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], {
    cwd: workDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FAX_PROVIDER: 'simulator',
      FAX_WEBHOOK_SECRET: '',
      PUBLIC_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(3000),
    ]);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* Windows can keep a WAL handle briefly; the temp folder is disposable. */
  }
});

test('serves health, security headers and the SPA fallback', async () => {
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.provider, 'simulator');
  assert.ok(health.body.engine.active >= 0);

  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.text, /Telno Faxline/);

  const route = await request('GET', '/outbox');
  assert.equal(route.status, 200);
  assert.match(route.headers.get('content-type'), /text\/html/);
  assert.match(route.text, /Telno Faxline/);

  const unknown = await request('GET', '/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /No API route/);
});

test('bootstraps the seeded workspace', async () => {
  const res = await request('GET', '/api/bootstrap');
  assert.equal(res.status, 200);
  seeded = res.body;

  assert.equal(seeded.settings.workspaceName, 'Meridian Group');
  assert.ok(seeded.settings.webhookSecret.length >= 10);
  assert.equal(seeded.numbers.length, 4);
  assert.equal(seeded.contacts.length, 9);
  assert.equal(seeded.faxes.length, 24);
  assert.ok(seeded.faxTotal >= 40);
  assert.equal(seeded.counts.unread, 4);
  assert.equal(seeded.counts.failed, 3);
  assert.equal(seeded.provider.active, 'simulator');
});

test('aggregates 30-day statistics', async () => {
  const res = await request('GET', '/api/stats?range=30');
  assert.equal(res.status, 200);
  assert.equal(res.body.days, 30);
  assert.equal(res.body.series.length, 30);
  assert.ok(res.body.sent > 0);
  assert.ok(res.body.received > 0);
  assert.ok(res.body.successRate > 0 && res.body.successRate <= 100);
  assert.ok(Array.isArray(res.body.topDestinations));
  assert.equal(res.body.hours.length, 24);
});

test('filters the fax list', async () => {
  const incoming = await request('GET', '/api/faxes?direction=in&limit=100');
  assert.equal(incoming.status, 200);
  assert.ok(incoming.body.items.length >= 14);
  assert.ok(incoming.body.items.every((fax) => fax.direction === 'in'));

  const failed = await request('GET', '/api/faxes?status=failed&limit=50');
  assert.equal(failed.body.items.length, 3);
  assert.ok(failed.body.items.every((fax) => fax.status === 'failed'));

  const unread = await request('GET', '/api/faxes?unread=true&limit=50');
  assert.equal(unread.body.items.length, 4);
});

test('creates a fax, renders its pages and exports a PDF', async () => {
  const created = await request('POST', '/api/faxes', {
    json: {
      to: '+1 (212) 555-0110',
      subject: 'E2E acceptance packet',
      note: 'Automated transmission from the end-to-end suite.',
      quality: 'fine',
      priority: 'high',
      tags: ['e2e'],
    },
  });
  assert.equal(created.status, 201);
  const fax = created.body.fax;
  createdFaxId = fax.id;
  assert.ok(fax.id);
  assert.ok(['queued', 'sending'].includes(fax.status));
  assert.ok(fax.pages >= 1);
  assert.match(fax.to_number, /212/);
  assert.equal(fax.costLabel, '$0.00');
  assert.ok(Array.isArray(fax.timeline) && fax.timeline.length >= 1);
  assert.equal(fax.timeline[0].detail, 'Accepted by Telno Faxline');

  const detail = await request('GET', `/api/faxes/${fax.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.fax.subject, 'E2E acceptance packet');

  const pages = await request('GET', `/api/faxes/${fax.id}/pages`);
  assert.equal(pages.status, 200);
  assert.equal(pages.body.pageCount, fax.pages);
  assert.equal(pages.body.pages.length, fax.pages);
  assert.equal(pages.body.pages[0].kind, 'cover');

  const svg = await request('GET', `/api/faxes/${fax.id}/page/0.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(svg.text, /^<svg/);

  const pdf = await bytes(`/api/faxes/${fax.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString('latin1'), '%PDF');
  assert.ok(pdf.buffer.length > 1000);
});

test('rejects invalid fax payloads', async () => {
  const noSubject = await request('POST', '/api/faxes', { json: { to: '+1 (212) 555-0110' } });
  assert.equal(noSubject.status, 422);
  assert.match(noSubject.body.error, /Subject/);

  const shortNumber = await request('POST', '/api/faxes', { json: { to: '12', subject: 'Too short' } });
  assert.equal(shortNumber.status, 422);

  const unknownNumber = await request('POST', '/api/faxes', {
    json: { to: '+1 (212) 555-0110', subject: 'Bad sender', fromNumberId: 'num_missing' },
  });
  assert.equal(unknownNumber.status, 422);
  assert.match(unknownNumber.body.error, /sending fax number/i);

  const malformed = await request('POST', '/api/faxes', {
    raw: '{"to":',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /Malformed JSON/);

  const pastSchedule = await request('POST', '/api/faxes', {
    json: {
      to: '+1 (212) 555-0110',
      subject: 'Yesterday',
      scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  });
  assert.equal(pastSchedule.status, 422);
  assert.match(pastSchedule.body.error, /future/);
});

test('previews unsaved cover artwork', async () => {
  const res = await request('POST', '/api/preview', {
    json: {
      to: '+1 (212) 555-0110',
      subject: 'Preview only',
      note: 'Nothing is stored.',
      template: 'minimal',
      quality: 'ultra',
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.pageCount >= 1);
  assert.equal(res.body.pages.length, res.body.pageCount);
  assert.match(res.body.pages[0].svg, /^<svg/);
  assert.ok(res.body.cost);
});

test('uploads a document and attaches it to a fax', async () => {
  const pdfBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type /Page /MediaBox [0 0 612 792]>>endobj\ntrailer<<>>\n%%EOF\n',
    'latin1',
  );
  const form = new FormData();
  form.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'acceptance.pdf');

  const upload = await request('POST', '/api/uploads', { form });
  assert.equal(upload.status, 200);
  const doc = upload.body.documents[0];
  assert.ok(doc.id);
  assert.equal(doc.mime, 'application/pdf');
  assert.equal(doc.name, 'acceptance.pdf');

  const stored = await bytes(`/api/files/${doc.id}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.buffer.subarray(0, 4).toString('latin1'), '%PDF');

  const fax = await request('POST', '/api/faxes', {
    json: { to: '+1 (212) 555-0110', subject: 'Fax with attachment', documentIds: [doc.id] },
  });
  assert.equal(fax.status, 201);
  assert.equal(fax.body.fax.pages, 2);
  assert.equal(fax.body.fax.documents.length, 1);
  assert.equal(fax.body.fax.documents[0].name, 'acceptance.pdf');

  const missingDoc = await request('POST', '/api/faxes', {
    json: { to: '+1 (212) 555-0110', subject: 'Ghost attachment', documentIds: ['file_missing'] },
  });
  assert.equal(missingDoc.status, 422);
  assert.match(missingDoc.body.error, /no longer exists/);
});

test('manages contacts', async () => {
  const created = await request('POST', '/api/contacts', {
    json: { name: 'E2E Contact', fax: '+1 (503) 555-0101', email: 'e2e@example.com', group: 'Testing' },
  });
  assert.equal(created.status, 201);
  const id = created.body.contact.id;

  const patched = await request('PATCH', `/api/contacts/${id}`, {
    json: { name: 'E2E Contact Updated', favorite: true },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.contact.name, 'E2E Contact Updated');
  assert.equal(patched.body.contact.favorite, true);

  const list = await request('GET', '/api/contacts');
  assert.ok(list.body.contacts.some((contact) => contact.id === id && contact.favorite === true));

  const badEmail = await request('POST', '/api/contacts', {
    json: { name: 'Bad Email', fax: '+1 (503) 555-0102', email: 'not-an-email' },
  });
  assert.equal(badEmail.status, 422);

  const removed = await request('DELETE', `/api/contacts/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);

  const gone = await request('PATCH', `/api/contacts/${id}`, { json: { name: 'Nope' } });
  assert.equal(gone.status, 404);
});

test('provisions numbers and protects the default line', async () => {
  const created = await request('POST', '/api/numbers', {
    json: { number: '+1 (503) 555-0199', label: 'E2E line', region: 'US-OR' },
  });
  assert.equal(created.status, 201);
  const id = created.body.number.id;
  assert.deepEqual(created.body.number.capabilities, ['send', 'receive']);

  const duplicate = await request('POST', '/api/numbers', { json: { number: '+1 (503) 555-0199' } });
  assert.equal(duplicate.status, 409);

  const patched = await request('PATCH', `/api/numbers/${id}`, { json: { label: 'E2E line renamed' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.number.label, 'E2E line renamed');

  const defaultId = seeded.settings.defaultNumberId || seeded.numbers.find((n) => n.is_default).id;
  const refused = await request('DELETE', `/api/numbers/${defaultId}`);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /default number/);

  const released = await request('DELETE', `/api/numbers/${id}`);
  assert.equal(released.status, 200);
  assert.equal(released.body.deleted, true);
});

test('issues API keys with scopes and enforces them on /api/v1', async () => {
  const anonymous = await request('GET', '/api/v1/faxes');
  assert.equal(anonymous.status, 401);

  const readKey = await request('POST', '/api/keys', { json: { name: 'E2E read', scopes: ['read'] } });
  assert.equal(readKey.status, 201);
  assert.match(readKey.body.key, /^fx_live_/);
  assert.equal(readKey.body.apiKey.hash, undefined);
  assert.deepEqual(readKey.body.apiKey.scopes, ['read']);

  const listed = await request('GET', '/api/v1/faxes?limit=3', {
    headers: { Authorization: `Bearer ${readKey.body.key}` },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 3);
  assert.ok('status' in listed.body.data[0]);
  assert.ok(!('note' in listed.body.data[0]));

  const writeBlocked = await request('POST', '/api/v1/faxes', {
    headers: { Authorization: `Bearer ${readKey.body.key}` },
    json: { to: '+1 (212) 555-0110', subject: 'Scope check' },
  });
  assert.equal(writeBlocked.status, 403);
  assert.match(writeBlocked.body.error, /"write" scope/);

  const writeKey = await request('POST', '/api/keys', { json: { name: 'E2E write', scopes: ['read', 'write'] } });
  assert.equal(writeKey.status, 201);

  const sent = await request('POST', '/api/v1/faxes', {
    headers: { Authorization: `Bearer ${writeKey.body.key}` },
    json: { to: '+1 (212) 555-0110', subject: 'API E2E fax', recipientName: 'API test' },
  });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.data.id);
  assert.ok(['queued', 'sending'].includes(sent.body.data.status));

  const revoked = await request('DELETE', `/api/keys/${readKey.body.apiKey.id}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);

  const afterRevoke = await request('GET', '/api/v1/faxes', {
    headers: { Authorization: `Bearer ${readKey.body.key}` },
  });
  assert.equal(afterRevoke.status, 401);
});

test('validates and persists settings', async () => {
  const badAccent = await request('PATCH', '/api/settings', { json: { accent: 'blue' } });
  assert.equal(badAccent.status, 422);

  const badHook = await request('PATCH', '/api/settings', { json: { webhookUrl: 'not-a-url' } });
  assert.equal(badHook.status, 422);

  const saved = await request('PATCH', '/api/settings', {
    json: { accent: '#112233', userName: 'E2E Operator', retentionDays: 120 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.accent, '#112233');
  assert.equal(saved.body.settings.userName, 'E2E Operator');
  assert.equal(saved.body.settings.retentionDays, 120);

  const bootstrap = await request('GET', '/api/bootstrap');
  assert.equal(bootstrap.body.settings.userName, 'E2E Operator');
});

test('stars, reads and deletes a fax', async () => {
  assert.ok(createdFaxId, 'a fax must exist from the earlier test');

  const starred = await request('POST', `/api/faxes/${createdFaxId}/star`, { json: { starred: true } });
  assert.equal(starred.status, 200);
  assert.equal(starred.body.fax.starred, true);

  const read = await request('POST', `/api/faxes/${createdFaxId}/read`, { json: {} });
  assert.equal(read.status, 200);
  assert.equal(read.body.fax.read, true);

  const removed = await request('DELETE', `/api/faxes/${createdFaxId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);

  const gone = await request('GET', `/api/faxes/${createdFaxId}`);
  assert.equal(gone.status, 404);
});

test('holds a scheduled fax and cancels it', async () => {
  const created = await request('POST', '/api/faxes', {
    json: {
      to: '+1 (212) 555-0110',
      subject: 'Scheduled E2E fax',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.fax.status, 'scheduled');

  const cancelled = await request('POST', `/api/faxes/${created.body.fax.id}/cancel`, { json: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.fax.status, 'cancelled');
});

test('simulates an inbound fax into the inbox', async () => {
  const before = await request('GET', '/api/bootstrap');
  const inbound = await request('POST', '/api/dev/simulate-inbound', { json: {} });
  assert.equal(inbound.status, 200);
  assert.equal(inbound.body.fax.direction, 'in');
  assert.equal(inbound.body.fax.status, 'received');
  assert.equal(inbound.body.fax.read, false);

  const afterInbound = await request('GET', '/api/bootstrap');
  assert.equal(afterInbound.body.counts.unread, before.body.counts.unread + 1);
});

test('applies signed provider webhooks and rejects unsigned ones', async () => {
  const created = await request('POST', '/api/faxes', {
    json: { to: '+1 (650) 555-0193', subject: 'Provider webhook target' },
  });
  const faxId = created.body.fax.id;
  const secret = seeded.settings.webhookSecret;

  const body = JSON.stringify({ data: { faxId, status: 'delivered', durationSec: 42 } });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const delivered = await request('POST', '/api/webhooks/provider', {
    raw: body,
    headers: { 'Content-Type': 'application/json', 'X-Faxline-Signature': `sha256=${signature}` },
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.status, 'delivered');

  const fax = await request('GET', `/api/faxes/${faxId}`);
  assert.equal(fax.body.fax.status, 'delivered');
  assert.ok(fax.body.fax.cost_cents > 0);
  assert.ok(fax.body.fax.timeline.some((entry) => entry.status === 'delivered'));

  const forged = await request('POST', '/api/webhooks/provider', {
    raw: body,
    headers: { 'Content-Type': 'application/json', 'X-Faxline-Signature': 'sha256=deadbeef' },
  });
  assert.equal(forged.status, 401);
  assert.match(forged.body.error, /signature/i);

  const unsupportedBody = JSON.stringify({ data: { faxId, status: 'banana' } });
  const unsupportedSignature = crypto.createHmac('sha256', secret).update(unsupportedBody).digest('hex');
  const unsupported = await request('POST', '/api/webhooks/provider', {
    raw: unsupportedBody,
    headers: { 'Content-Type': 'application/json', 'X-Faxline-Signature': `sha256=${unsupportedSignature}` },
  });
  assert.equal(unsupported.status, 422);
  assert.match(unsupported.body.error, /Unsupported provider status/);
});

test('forces a simulated failure, then reseeds the workspace', async () => {
  await waitForEngineIdle();
  const armed = await request('POST', '/api/dev/fail-next', { json: { enabled: true } });
  assert.equal(armed.status, 200);
  assert.equal(armed.body.forceFail, true);

  const created = await request('POST', '/api/faxes', {
    json: { to: '+1 (212) 555-0110', subject: 'E2E forced failure' },
  });
  const failed = await waitForFax(created.body.fax.id, (fax) => fax.status === 'failed');
  assert.ok(failed.error_code);
  assert.ok(failed.error_message);
  assert.equal(failed.cost_cents, 0);

  const reset = await request('POST', '/api/dev/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);

  const reseeded = await request('GET', '/api/bootstrap');
  assert.equal(reseeded.body.numbers.length, 4);
  assert.equal(reseeded.body.contacts.length, 9);
  assert.equal(reseeded.body.counts.failed, 3);
  assert.equal(reseeded.body.counts.unread, 4);
  assert.equal(reseeded.body.settings.userName, 'Avery Chen');
});
