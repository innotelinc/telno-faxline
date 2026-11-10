/** Server-sent-events hub: one broadcast fan-out for fax status, events and stats. */
const clients = new Set();
let heartbeatTimer = null;

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => broadcast('ping', { t: Date.now() }), 20000);
  heartbeatTimer.unref?.();
}

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2500\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  clients.add(res);
  ensureHeartbeat();

  const cleanup = () => {
    clients.delete(res);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

export function broadcast(type, data) {
  if (!clients.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const res of Array.from(clients)) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
