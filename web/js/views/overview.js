import { esc, fmt, icon, statusMeta, statusPill } from '../lib.js';
import { areaChart, donut, sparkline } from '../charts.js';

function kpi({ label, value, unit = '', foot, spark, trend }) {
  return `<div class="kpi">
    <p class="kpi__label">${esc(label)}${trend ? `<span class="kpi__delta ${trend < 0 ? 'kpi__delta--down' : ''}">${trend > 0 ? '+' : ''}${trend}%</span>` : ''}</p>
    <p class="kpi__value">${esc(value)}${unit ? `<span class="kpi__unit">${esc(unit)}</span>` : ''}</p>
    <p class="kpi__foot">${foot}</p>
    ${spark || ''}
  </div>`;
}

function recentRows(faxes, ctx) {
  if (!faxes.length) {
    return `<tr><td colspan="6"><div class="empty" style="border:0;background:none;padding:32px"><p class="empty__text">No faxes yet. Send one to see it here.</p></div></td></tr>`;
  }
  return faxes
    .slice(0, 7)
    .map((fax) => {
      const inbound = fax.direction === 'in';
      const meta = statusMeta(fax.status);
      return `<tr data-clickable="true" data-fax="${esc(fax.id)}" tabindex="0">
        <td>
          <div class="cell-main">
            <span class="dir-icon ${inbound ? '' : 'dir-icon--out'}">${icon(inbound ? 'inbox' : 'send', 13)}</span>
            <div class="cell-main__text">
              <span class="cell-title">${esc(fax.subject || 'Untitled fax')}</span>
              <span class="cell-sub">${esc(inbound ? fax.recipient_name : fax.recipient_name)}</span>
            </div>
          </div>
        </td>
        <td class="hide-sm"><span class="num">${esc(inbound ? fax.from_number : fax.to_number)}</span></td>
        <td>${statusPill(fax.status)}</td>
        <td class="num">${fmt.plural(fax.pages, 'page')}</td>
        <td class="num hide-sm">${esc(fmt.relative(fax.created_at))}</td>
        <td class="num">${fax.cost_cents ? esc(fmt.money(fax.cost_cents)) : '—'}</td>
      </tr>`;
    })
    .join('');
}

function eventFeed(events) {
  if (!events.length) {
    return `<div class="feed__item"><div class="feed__icon">${icon('sparkle', 12)}</div>
      <div class="feed__body"><p class="feed__text">Nothing has happened yet.</p></div></div>`;
  }
  return events
    .slice(0, 7)
    .map((event) => {
      const tone =
        event.level === 'error' ? 'feed__icon--err' : event.type.startsWith('fax.delivered') || event.type.startsWith('fax.received')
          ? 'feed__icon--ok'
          : event.type === 'fax.failed'
            ? 'feed__icon--err'
            : event.type.startsWith('webhook')
              ? 'feed__icon--warn'
              : '';
      const eventIcons = {
        'fax.delivered': 'check',
        'fax.received': 'inbox',
        'fax.failed': 'alert',
        'fax.queued': 'send',
        'fax.scheduled': 'calendar',
        'fax.cancelled': 'x',
        'fax.retried': 'refresh',
        'fax.released': 'play',
        'document.uploaded': 'file',
        'key.created': 'key',
        'key.revoked': 'lock',
        'webhook.sent': 'webhook',
        'webhook.failed': 'alert',
        'number.provisioned': 'numbers',
        'contact.created': 'contacts',
        'workspace.ready': 'sparkle',
      };
      return `<div class="feed__item">
        <div class="feed__icon ${tone}">${icon(eventIcons[event.type] || 'dot', 12)}</div>
        <div class="feed__body">
          <p class="feed__text">${esc(event.message || event.type)}</p>
          <p class="feed__time">${esc(fmt.relative(event.created_at))}</p>
        </div>
      </div>`;
    })
    .join('');
}

export async function render(ctx) {
  const { state } = ctx;
  const stats = state.stats || { series: [], hours: [], topDestinations: [] };
  const sentSeries = stats.series.map((point) => point.sent);
  const receivedSeries = stats.series.map((point) => point.received);
  const provider = state.provider;
  const settings = state.settings || {};
  const unread = state.counts.unread;
  const first = state.numbers[0];

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Fax operations · last 30 days</p>
        <h1 class="page-title">${greeting()}, ${esc((settings.userName || 'there').split(' ')[0])}</h1>
        <p class="page-sub">
          ${unread ? `<strong style="color:var(--fg)">${fmt.plural(unread, 'inbound fax', 'inbound faxes')}</strong> waiting in the inbox.` : 'Inbox is clear.'}
          ${stats.sent ? `${fmt.num(stats.sent)} transmissions sent with a ${fmt.pct(stats.successRate)} delivery rate.` : ''}
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--secondary" type="button" data-action="simulate-inbound">${icon('inbox', 15)} Simulate inbound</button>
        <a class="btn btn--primary" href="/send" data-link>${icon('send', 15)} New fax</a>
      </div>
    </header>

    <div class="kpi-grid">
      ${kpi({
        label: 'Transmissions',
        value: fmt.num(stats.sent),
        foot: `<span>${fmt.num(stats.delivered)} delivered · ${fmt.num(stats.failed)} failed</span>`,
        spark: sparkline(sentSeries, { color: 'var(--chart-1)' }),
      })}
      ${kpi({
        label: 'Received',
        value: fmt.num(stats.received),
        foot: `<span>${fmt.plural(stats.pages, 'page')} captured</span>`,
        spark: sparkline(receivedSeries, { color: 'var(--chart-2)' }),
      })}
      ${kpi({
        label: 'Delivery rate',
        value: fmt.pct(stats.successRate),
        foot: `<span>Avg ${esc(fmt.duration(stats.avgSeconds))} per fax</span>`,
      })}
      ${kpi({
        label: 'Spend',
        value: fmt.money(stats.spendCents).replace('$', '$'),
        foot: `<span>${fmt.money(stats.monthlyCents)}/mo number rental</span>`,
      })}
    </div>

    <section class="hero-send" aria-label="Quick send">
      <div class="hero-send__text">
        <p class="hero-send__title">Send a fax in seconds</p>
        <p class="hero-send__sub">Enter a destination number — Telno Faxline builds the cover page and estimates the cost.</p>
      </div>
      <form class="hero-send__form" data-quick-send>
        <label class="sr-only" for="quick-to">Recipient fax number</label>
        <input class="input input--mono" id="quick-to" name="to" placeholder="+1 (212) 555-0110" autocomplete="off" />
        <button class="btn btn--primary" type="submit">${icon('arrowRight', 15)} Compose</button>
      </form>
    </section>

    <div class="grid" style="grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)">
      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Volume</h2>
            <p class="card__desc">Outbound and inbound faxes per day</p>
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-swatch"></span>Sent</span>
            <span class="legend-item"><span class="legend-swatch legend-swatch--2"></span>Received</span>
          </div>
        </div>
        <div class="card__body">
          ${areaChart(stats.series, { keys: ['sent', 'received'] })}
        </div>
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Delivery outcomes</h2>
            <p class="card__desc">Settled transmissions</p>
          </div>
        </div>
        <div class="card__body" style="display:flex;flex-direction:column;gap:16px">
          <div class="donut-wrap">
            ${donut(
              [
                { value: stats.delivered, color: 'var(--chart-2)', label: 'Delivered' },
                { value: stats.failed, color: 'var(--chart-4)', label: 'Failed' },
              ],
              { center: `${stats.delivered + stats.failed}`, sub: 'SETTLED' },
            )}
            <div class="stack" style="gap:8px;flex:1">
              <div class="row row--between"><span class="row" style="gap:7px"><span class="legend-swatch legend-swatch--2"></span><span class="muted" style="font-size:var(--fs-2)">Delivered</span></span><strong class="mono" style="font-size:12px">${fmt.num(stats.delivered)}</strong></div>
              <div class="row row--between"><span class="row" style="gap:7px"><span class="legend-swatch legend-swatch--4"></span><span class="muted" style="font-size:var(--fs-2)">Failed</span></span><strong class="mono" style="font-size:12px">${fmt.num(stats.failed)}</strong></div>
              <div class="row row--between"><span class="row" style="gap:7px"><span class="legend-swatch"></span><span class="muted" style="font-size:var(--fs-2)">Avg duration</span></span><strong class="mono" style="font-size:12px">${esc(fmt.duration(stats.avgSeconds))}</strong></div>
            </div>
          </div>
          ${stats.topDestinations?.length ? `
          <div>
            <p class="eyebrow" style="margin-bottom:8px">Top destinations</p>
            <div class="bars">
              ${stats.topDestinations.map((destination, index) => `
                <div class="bar-row">
                  <span class="truncate" title="${esc(destination.label)}">${esc(destination.label)}</span>
                  <span class="bar-track"><span class="bar-fill ${index % 2 ? 'bar-fill--2' : ''}" style="width:${Math.max(6, Math.round((destination.count / stats.topDestinations[0].count) * 100))}%"></span></span>
                  <span class="bar-count">${destination.count}</span>
                </div>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </section>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)">
      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Recent faxes</h2>
            <p class="card__desc">Click a row to inspect pages and delivery timeline</p>
          </div>
          <a class="section-link" href="/outbox" data-link>Outbox ${icon('arrowRight', 12)}</a>
        </div>
        <div class="card__body" style="padding:12px 0 0">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Fax</th><th class="hide-sm">Number</th><th>Status</th><th>Pages</th><th class="hide-sm">When</th><th>Cost</th></tr></thead>
              <tbody>${recentRows(state.faxes, ctx)}</tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Activity</h2>
            <p class="card__desc">Workspace event log</p>
          </div>
          <a class="section-link" href="/developer" data-link>All events ${icon('arrowRight', 12)}</a>
        </div>
        <div class="card__body" style="padding:8px 0 0">
          <div class="feed">${eventFeed(state.events)}</div>
        </div>
      </section>
    </div>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Number health</h2>
            <p class="card__desc">${fmt.plural(state.numbers.length, 'number')} · ${esc(provider?.name || 'Simulator')}</p>
          </div>
          <a class="section-link" href="/numbers" data-link>Manage ${icon('arrowRight', 12)}</a>
        </div>
        <div class="card__body" style="padding:0">
          <div class="number-health">
            ${state.numbers.map((number) => `
              <div class="number-health__row">
                <span class="dir-icon">${icon('numbers', 13)}</span>
                <div class="number-health__main">
                  <p class="number-health__label">${esc(number.label)} ${number.is_default ? '<span class="tag" style="margin-left:6px">Default</span>' : ''}</p>
                  <p class="number-health__num">${esc(number.number)} · ${esc(number.region)}</p>
                </div>
                <div class="number-health__meta">
                  <span>${number.inbound_count} in</span>
                  <span>${esc(fmt.money(number.monthly_cents))}/mo</span>
                </div>
                <span class="status-dot ${number.status === 'active' ? '' : 'status-dot--warn'}"></span>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">Busiest hours</h2>
            <p class="card__desc">Outbound starts by hour of day</p>
          </div>
        </div>
        <div class="card__body">
          ${hourSummary(stats.hours)}
        </div>
      </section>
    </div>`;

  return {
    html,
    mount(root) {
      root.querySelector('[data-quick-send]')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const to = root.querySelector('#quick-to').value.trim();
        ctx.navigate(to ? `/send?to=${encodeURIComponent(to)}` : '/send');
      });

      root.querySelectorAll('[data-fax]').forEach((row) => {
        const open = () => ctx.openFax(row.dataset.fax);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
      });

      root.querySelector('[data-action="simulate-inbound"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const { fax } = await (await import('../lib.js')).api.post('/api/dev/simulate-inbound', {});
          ctx.toast.success('Inbound fax received', `${fax.recipient_name} · ${fax.pages} page(s)`);
          await ctx.reload();
        } catch (error) {
          ctx.toast.error('Could not simulate a fax', error.message);
        } finally {
          button.disabled = false;
        }
      });
    },
  };
}

function hourSummary(hours = []) {
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(max);
  return `
    <div class="stack" style="gap:12px">
      <div class="row row--between">
        <div>
          <p class="eyebrow">Peak window</p>
          <p style="font-size:var(--fs-5);font-weight:700;letter-spacing:-0.02em">${String(peak).padStart(2, '0')}:00 – ${String((peak + 1) % 24).padStart(2, '0')}:00</p>
        </div>
        <span class="pill pill--accent">${max} fax${max === 1 ? '' : 'es'}</span>
      </div>
      ${hourBarsMarkup(hours)}
      <p class="muted" style="font-size:var(--fs-1)">Most transmissions start mid-morning. Schedule large batches outside the peak to keep retries inside business hours.</p>
    </div>`;
}

function hourBarsMarkup(hours) {
  const max = Math.max(1, ...hours);
  const bars = hours
    .map(
      (value, hour) =>
        `<div class="hours__bar" style="height:${Math.max(3, Math.round((value / max) * 100))}%" data-peak="${value === max && value > 0}" title="${String(hour).padStart(2, '0')}:00 · ${value}"></div>`,
    )
    .join('');
  return `<div class="hours">${bars}</div>`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
