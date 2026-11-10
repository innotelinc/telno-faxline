/* Hand-rolled SVG chart primitives — no chart dependency, fully themed by tokens. */

let gradientId = 0;

const niceCeiling = (max) => {
  const value = Math.max(1, max);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = magnitude / 2 || 1;
  return Math.ceil(value / step) * step;
};

export function sparkline(values, { width = 220, height = 44, color = 'var(--chart-1)' } = {}) {
  if (!values?.length) return '';
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = height - 2 - (value / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const id = `spark-${++gradientId}`;
  return `<svg class="kpi__spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="M${points.join(' L')} L${width},${height} L0,${height} Z" fill="url(#${id})"/>
    <path d="M${points.join(' L')}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export function areaChart(series, { keys = ['sent', 'received'], labels = ['Sent', 'Received'], colors = ['var(--chart-1)', 'var(--chart-2)'], height = 216 } = {}) {
  const width = 760;
  const pad = { top: 16, right: 14, bottom: 26, left: 32 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxValue = niceCeiling(
    Math.max(1, ...series.flatMap((point) => keys.map((key) => Number(point[key]) || 0))),
  );
  const x = (index) => pad.left + (series.length <= 1 ? innerW / 2 : (index / (series.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - ((Number(value) || 0) / maxValue) * innerH;

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const value = (maxValue / 4) * index;
    const py = y(value);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" stroke="var(--grid-line)" stroke-width="1"/>
      <text x="${pad.left - 8}" y="${(py + 3).toFixed(1)}" text-anchor="end" class="chart-tip">${Math.round(value)}</text>`;
  }).join('');

  const tickEvery = Math.max(1, Math.round(series.length / 6));
  const xLabels = series
    .map((point, index) => {
      if (index % tickEvery !== 0 && index !== series.length - 1) return '';
      const [, month, day] = point.date.split('-');
      return `<text x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="chart-tip">${month}/${day}</text>`;
    })
    .join('');

  const layer = keys
    .map((key, keyIndex) => {
      const color = colors[keyIndex] || colors[0];
      const id = `area-${++gradientId}`;
      const line = series
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`)
        .join(' ');
      const area = `${line} L${x(series.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
      return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="${keyIndex === 0 ? 0.24 : 0.16}"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#${id})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');

  const hits = series
    .map(
      (point, index) => `<g><rect x="${(x(index) - innerW / (series.length * 2)).toFixed(1)}" y="${pad.top}" width="${Math.max(4, innerW / series.length).toFixed(1)}" height="${innerH}" fill="transparent">
        <title>${point.date} · ${labels[0]}: ${point[keys[0]] ?? 0}${keys[1] ? ` · ${labels[1]}: ${point[keys[1]] ?? 0}` : ''}</title>
      </rect></g>`,
    )
    .join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fax volume by day">
    ${gridLines}${layer}${xLabels}${hits}
  </svg>`;
}

export function donut(segments, { size = 132, thickness = 13, center = '', sub = '' } = {}) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = segments
    .map((segment) => {
      const value = Number(segment.value) || 0;
      const share = total ? value / total : 0;
      const length = share * circumference;
      const ring = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${thickness}"
        stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="butt"><title>${segment.label}: ${value}</title></circle>`;
      offset += length;
      return ring;
    })
    .join('');
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Delivery outcomes">
    <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--surface-muted)" stroke-width="${thickness}"/>
    ${rings}
    ${center ? `<text x="${size / 2}" y="${size / 2 + 2}" text-anchor="middle" class="donut__center">${center}</text>` : ''}
    ${sub ? `<text x="${size / 2}" y="${size / 2 + 18}" text-anchor="middle" class="donut__sub">${sub}</text>` : ''}
  </svg>`;
}

export function hourBars(hours) {
  const max = Math.max(1, ...hours);
  const bars = hours
    .map(
      (value, hour) =>
        `<div class="hours__bar" style="height:${Math.max(3, Math.round((value / max) * 100))}%" data-peak="${value === max && value > 0}" title="${String(hour).padStart(2, '0')}:00 · ${value} fax${value === 1 ? '' : 's'}"></div>`,
    )
    .join('');
  const axis = Array.from({ length: 24 }, (_, hour) =>
    hour % 3 === 0 ? `<span>${String(hour).padStart(2, '0')}</span>` : '<span></span>',
  ).join('');
  return `<div class="hours">${bars}</div><div class="hours-axis">${axis}</div>`;
}
