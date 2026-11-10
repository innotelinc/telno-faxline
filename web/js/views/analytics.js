import { esc, fmt, icon } from '../lib.js';
import { areaChart, donut, hourBars } from '../charts.js';

export async function render(ctx) {
  const { state } = ctx;
  const query = new URLSearchParams(window.location.search);
  const range = [7, 30, 90].includes(Number(query.get('range'))) ? Number(query.get('range')) : state.range || 30;
  const stats = await ctx.refreshStats(range);
  const failures = state.faxes.filter((fax) => fax.status === 'failed');
  const failureCodes = failures.reduce((map, fax) => {
    const code = fax.error_code || 'UNKNOWN';
    map.set(code, (map.get(code) || 0) + 1);
    return map;
  }, new Map());
  const failureRows = Array.from(failureCodes.entries()).sort((a, b) => b[1] - a[1]);
  const failureMax = Math.max(1, ...failureRows.map(([, count]) => count));

  const html = `
    <header class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">Insights</p>
        <h1 class="page-title">Analytics</h1>
        <p class="page-sub">Volume, reliability and spend for the last ${range} days. Delivery outcomes come from carrier confirmations, not client-side assumptions.</p>
      </div>
      <div class="page-head__actions">
        <div class="segmented" role="group" aria-label="Date range">
          ${[7, 30, 90]
            .map(
              (days) =>
                `<button type="button" data-range="${days}" aria-pressed="${days === range}">${days}d</button>`,
            )
            .join('')}
        </div>
        <a class="btn btn--secondary" href="/api/faxes?direction=all&limit=100" download>${icon('download', 15)} Export</a>
      </div>
    </header>

    <div class="kpi-grid">
      ${[
        { label: 'Sent', value: fmt.num(stats.sent), foot: `${fmt.num(stats.pages)} pages total` },
        { label: 'Delivered', value: fmt.num(stats.delivered), foot: `${fmt.num(stats.failed)} failed` },
        { label: 'Success rate', value: fmt.pct(stats.successRate), foot: `Avg ${fmt.duration(stats.avgSeconds)} per fax` },
        { label: 'Spend', value: fmt.money(stats.spendCents), foot: `+ ${fmt.money(stats.monthlyCents)} number rental` },
      ]
        .map(
          (item) => `<div class="kpi">
            <p class="kpi__label">${esc(item.label)}</p>
            <p class="kpi__value">${esc(item.value)}</p>
            <p class="kpi__foot">${esc(item.foot)}</p>
          </div>`,
        )
        .join('')}
    </div>

    <section class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Volume by day</h2>
          <p class="card__desc">Last ${range} days · outbound vs inbound</p>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-swatch"></span>Sent</span>
          <span class="legend-item"><span class="legend-swatch legend-swatch--2"></span>Received</span>
        </div>
      </div>
      <div class="card__body">${areaChart(stats.series, { keys: ['sent', 'received'], height: 240 })}</div>
    </section>

    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <section class="card">
        <div class="card__head">
          <div><h2 class="card__title">Outcomes</h2><p class="card__desc">Settled transmissions only</p></div>
        </div>
        <div class="card__body">
          <div class="donut-wrap">
            ${donut(
              [
                { value: stats.delivered, color: 'var(--chart-2)', label: 'Delivered' },
                { value: stats.failed, color: 'var(--chart-4)', label: 'Failed' },
              ],
              { size: 148, center: fmt.pct(stats.successRate), sub: 'DELIVERED' },
            )}
            <div class="stack" style="gap:10px;flex:1">
              <div class="row row--between"><span class="row" style="gap:7px"><span class="legend-swatch legend-swatch--2"></span><span class="muted" style="font-size:var(--fs-2)">Delivered</span></span><strong class="mono" style="font-size:12px">${fmt.num(stats.delivered)}</strong></div>
              <div class="row row--between"><span class="row" style="gap:7px"><span class="legend-swatch legend-swatch--4"></span><span class="muted" style="font-size:var(--fs-2)">Failed</span></span><strong class="mono" style="font-size:12px">${fmt.num(stats.failed)}</strong></div>
              <hr class="divider" />
              <div class="row row--between"><span class="muted" style="font-size:var(--fs-2)">Pages transmitted</span><strong class="mono" style="font-size:12px">${fmt.num(stats.pages)}</strong></div>
              <div class="row row--between"><span class="muted" style="font-size:var(--fs-2)">Cost per delivered page</span><strong class="mono" style="font-size:12px">${stats.pages ? esc(fmt.money(Math.round(stats.spendCents / Math.max(1, stats.pages)))) : '—'}</strong></div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__head">
          <div><h2 class="card__title">Top destinations</h2><p class="card__desc">By transmission count</p></div>
        </div>
        <div class="card__body">
          ${stats.topDestinations?.length
            ? `<div class="bars">${stats.topDestinations
                .map(
                  (destination, index) => `<div class="bar-row">
                    <span class="truncate" title="${esc(destination.label)}">${esc(destination.label)}</span>
                    <span class="bar-track"><span class="bar-fill ${index % 2 ? 'bar-fill--2' : ''}" style="width:${Math.max(6, Math.round((destination.count / stats.topDestinations[0].count) * 100))}%"></span></span>
                    <span class="bar-count">${destination.count}</span>
                  </div>`,
                )
                .join('')}</div>`
            : `<p class="muted" style="font-size:var(--fs-2)">No outbound faxes in this window.</p>`}
        </div>
      </section>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <section class="card">
        <div class="card__head">
          <div><h2 class="card__title">When you send</h2><p class="card__desc">Outbound start time, local to the workspace</p></div>
        </div>
        <div class="card__body">${hourBars(stats.hours)}</div>
      </section>

      <section class="card">
        <div class="card__head">
          <div><h2 class="card__title">Failure codes</h2><p class="card__desc">Why transmissions did not complete</p></div>
        </div>
        <div class="card__body">
          ${failureRows.length
            ? `<div class="bars">${failureRows
                .map(
                  ([code, count]) => `<div class="bar-row">
                    <span class="mono" style="font-size:11px;color:var(--muted)">${esc(code)}</span>
                    <span class="bar-track"><span class="bar-fill" style="width:${Math.max(8, Math.round((count / failureMax) * 100))}%;background:linear-gradient(90deg,var(--chart-4),color-mix(in srgb,var(--chart-4) 55%,var(--chart-3)))"></span></span>
                    <span class="bar-count">${count}</span>
                  </div>`,
                )
                .join('')}</div>
              <p class="field__hint" style="margin-top:12px">Failed transmissions are not billed. Retries stay inside the configured attempt budget.</p>`
            : `<div class="empty" style="border:0;background:none;padding:24px 0">
                <div class="empty__icon">${icon('check', 18)}</div>
                <p class="empty__title">No failures</p>
                <p class="empty__text">Every settled transmission in this window was confirmed by the receiving device.</p>
              </div>`}
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card__head">
        <div><h2 class="card__title">Spend by day</h2><p class="card__desc">Delivered pages only</p></div>
      </div>
      <div class="card__body">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Date</th><th>Sent</th><th>Received</th><th>Pages</th><th>Spend</th></tr></thead>
            <tbody>
              ${stats.series
                .slice(-10)
                .reverse()
                .map(
                  (point) => `<tr>
                    <td class="num">${esc(point.date)}</td>
                    <td class="num">${point.sent}</td>
                    <td class="num">${point.received}</td>
                    <td class="num">${point.pages}</td>
                    <td class="num">${esc(fmt.money(point.cost))}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>`;

  return {
    html,
    mount(root) {
      root.querySelectorAll('[data-range]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.navigate(`/analytics?range=${button.dataset.range}`, { replace: true });
        });
      });
    },
  };
}
