/**
 * Fax document engine.
 *
 * One layout model, two serializers: SVG for on-screen previews and PDF for
 * download / provider transmission. Blocks are expressed in PDF points on a
 * US Letter page (612 x 792) with a top-left origin.
 */
import { escapeXml } from './util.js';

export const PAGE_W = 612;
export const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

const SANS = "'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Spline Sans Mono', Consolas, 'Courier New', monospace";

const NARROW = /[iljI|!.,;:'’`()[\]/\\]/;
const WIDE = /[mwMW@%]/;

function charWidth(ch, size) {
  if (ch === ' ') return size * 0.28;
  if (NARROW.test(ch)) return size * 0.28;
  if (WIDE.test(ch)) return size * 0.86;
  if (/[A-Z]/.test(ch)) return size * 0.66;
  return size * 0.53;
}

function measure(text, size) {
  let total = 0;
  for (const ch of String(text)) total += charWidth(ch, size);
  return total;
}

export function wrapText(text, size, maxWidth) {
  const paragraphs = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate, size) <= maxWidth || !current) {
        current = candidate;
        // A single word longer than the line still has to break somewhere.
        if (!current.includes(' ') && measure(current, size) > maxWidth) {
          let chunk = '';
          for (const ch of current) {
            if (measure(chunk + ch, size) > maxWidth) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
        }
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

const block = {
  text: (x, y, text, opts = {}) => ({
    type: 'text',
    x,
    y,
    text: String(text ?? ''),
    size: opts.size ?? 10.5,
    weight: opts.weight ?? 'normal',
    font: opts.font ?? 'sans',
    color: opts.color ?? '#181c1f',
    align: opts.align ?? 'left',
    tracking: opts.tracking ?? 0,
  }),
  rect: (x, y, w, h, fill) => ({ type: 'rect', x, y, w, h, fill }),
  rule: (x1, y, x2, color = 'rgba(1,5,7,0.14)', width = 0.8) => ({
    type: 'rule',
    x1,
    x2,
    y,
    color,
    width,
  }),
  image: (x, y, w, h, fileId, label) => ({ type: 'image', x, y, w, h, fileId, label }),
};

function colorOrDefault(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

/**
 * Builds the page model for a fax. Pure: the caller supplies every input so
 * stored renderings stay stable even if workspace settings change later.
 */
export function buildFaxRender({
  settings = {},
  from = '',
  to = '',
  recipientName = '',
  subject = '',
  note = '',
  documents = [],
  documentsTotalPages = null,
  createdAt = new Date().toISOString(),
  direction = 'out',
} = {}) {
  const accent = colorOrDefault(settings.accent, '#757cf2');
  const ink = '#181c1f';
  const muted = '#57575b';
  const soft = '#f7f7f9';
  const template = ['minimal', 'classic', 'branded'].includes(settings.coverTemplate)
    ? settings.coverTemplate
    : 'branded';
  const header = String(settings.coverHeader ?? settings.workspaceName ?? 'Fax').slice(0, 60);
  const legal = String(settings.coverFooter ?? '').slice(0, 320);
  const dateLabel = new Date(createdAt).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  const attachmentPages = documents.reduce((sum, doc) => sum + Math.max(1, Number(doc.pages) || 1), 0);
  const lineHeight = 15.5;
  const noteLines = note ? wrapText(note, 10.5, CONTENT_W) : ['(No cover message.)'];
  const noteTop = MARGIN + 214;
  const maxCoverLines = Math.max(4, Math.floor((PAGE_H - 250 - noteTop) / lineHeight));
  const notePlan = {
    used: noteLines.slice(0, maxCoverLines),
    overflow: noteLines.slice(maxCoverLines),
  };
  const totalPages = 1 + (notePlan.overflow.length ? 1 : 0) + attachmentPages;

  const pages = [];
  const cover = [];

  if (template === 'branded') {
    cover.push(block.rect(MARGIN, MARGIN, 5, 66, accent));
  }

  cover.push(
    block.text(MARGIN + (template === 'branded' ? 18 : 0), MARGIN + 16, header, {
      size: 15,
      weight: 'bold',
      color: ink,
    }),
  );
  cover.push(
    block.text(
      MARGIN + (template === 'branded' ? 18 : 0),
      MARGIN + 36,
      direction === 'in' ? 'INBOUND FACSIMILE' : 'FACSIMILE TRANSMISSION',
      { size: 8, font: 'mono', color: muted, tracking: 1.2 },
    ),
  );
  cover.push(block.text(PAGE_W - MARGIN - 170, MARGIN + 16, dateLabel.toUpperCase(), {
    size: 8,
    font: 'mono',
    color: muted,
    align: 'right',
  }));
  cover.push(block.text(PAGE_W - MARGIN - 170, MARGIN + 30, `${totalPages} PAGE${totalPages === 1 ? '' : 'S'}`, {
    size: 8,
    font: 'mono',
    color: muted,
    align: 'right',
  }));
  cover.push(block.rule(MARGIN, MARGIN + 76, PAGE_W - MARGIN, 'rgba(1,5,7,0.16)', 1));

  const colY = MARGIN + 104;
  const colW = 224;

  cover.push(block.text(MARGIN, colY, 'TO', { size: 7.5, font: 'mono', color: muted, tracking: 1.4 }));
  cover.push(block.text(MARGIN, colY + 20, recipientName || 'Unnamed recipient', {
    size: 15,
    weight: 'bold',
    color: ink,
  }));
  cover.push(block.text(MARGIN, colY + 40, to || '—', { size: 11.5, font: 'mono', color: ink }));

  cover.push(block.text(MARGIN + 280, colY, 'FROM', { size: 7.5, font: 'mono', color: muted, tracking: 1.4 }));
  cover.push(block.text(MARGIN + 280, colY + 20, settings.senderName || settings.workspaceName || 'Faxline', {
    size: 15,
    weight: 'bold',
    color: ink,
  }));
  cover.push(block.text(MARGIN + 280, colY + 40, from || '—', { size: 11.5, font: 'mono', color: ink }));

  let y = colY + 74;
  cover.push(block.rect(MARGIN, y, CONTENT_W, 62, soft));
  if (template === 'branded') cover.push(block.rect(MARGIN, y, 3, 62, accent));
  cover.push(block.text(MARGIN + 16, y + 16, 'SUBJECT', { size: 7.5, font: 'mono', color: muted, tracking: 1.4 }));
  const subjectLines = wrapText(subject || '(no subject)', 13, CONTENT_W - 32).slice(0, 2);
  subjectLines.forEach((line, index) => {
    cover.push(
      block.text(MARGIN + 16, y + 34 + index * 15, line, { size: 13, weight: 'bold', color: ink }),
    );
  });

  y += 90;
  cover.push(block.text(MARGIN, y, 'MESSAGE', { size: 7.5, font: 'mono', color: muted, tracking: 1.4 }));
  y += 20;

  notePlan.used.forEach((line, index) => {
    cover.push(block.text(MARGIN, y + index * lineHeight, line, {
      size: 10.5,
      color: note ? ink : muted,
    }));
  });

  pages.push({ kind: 'cover', label: 'Cover page', blocks: cover });

  const overflow = notePlan.overflow;
  if (overflow.length) {
    const more = [];
    more.push(block.text(MARGIN, MARGIN + 20, header, { size: 12, weight: 'bold', color: ink }));
    more.push(block.text(MARGIN, MARGIN + 38, 'MESSAGE — CONTINUED', {
      size: 7.5,
      font: 'mono',
      color: muted,
      tracking: 1.4,
    }));
    more.push(block.rule(MARGIN, MARGIN + 50, PAGE_W - MARGIN));
    overflow.forEach((line, index) => {
      more.push(block.text(MARGIN, MARGIN + 74 + index * lineHeight, line, { size: 10.5, color: ink }));
    });
    pages.push({ kind: 'continuation', label: 'Message continued', blocks: more });
  }

  documents.forEach((doc, index) => {
    const docIndex = pages.length;
    const blocks = [];
    blocks.push(block.text(MARGIN, MARGIN + 20, doc.name || `Document ${index + 1}`, {
      size: 12,
      weight: 'bold',
      color: ink,
    }));
    blocks.push(
      block.text(MARGIN, MARGIN + 38, `ATTACHMENT ${index + 1} OF ${documents.length}`, {
        size: 7.5,
        font: 'mono',
        color: muted,
        tracking: 1.4,
      }),
    );
    blocks.push(block.rule(MARGIN, MARGIN + 50, PAGE_W - MARGIN));

    if (doc.kind === 'image') {
      blocks.push(block.image(MARGIN, MARGIN + 68, CONTENT_W, 560, doc.id, doc.name));
    } else {
      blocks.push(block.rect(MARGIN, MARGIN + 68, CONTENT_W, 560, soft));
      blocks.push(
        block.text(MARGIN + 24, MARGIN + 106, 'Rendered by the receiving fax machine', {
          size: 11,
          color: muted,
        }),
      );
      blocks.push(
        block.text(MARGIN + 24, MARGIN + 128, `${doc.name}`, { size: 13, weight: 'bold', color: ink }),
      );
      blocks.push(
        block.text(MARGIN + 24, MARGIN + 148, `${doc.pages || 1} page(s) · ${doc.sizeLabel || ''}`, {
          size: 9,
          font: 'mono',
          color: muted,
        }),
      );
    }
    pages.push({
      kind: 'document',
      label: doc.name || `Attachment ${index + 1}`,
      blocks,
      image: doc.kind === 'image' ? { fileId: doc.id, name: doc.name } : null,
      docIndex,
    });
  });

  // Page furniture is added after assembly so numbering is exact.
  pages.forEach((page, index) => {
    const footer = [];
    footer.push(block.rule(MARGIN, PAGE_H - 72, PAGE_W - MARGIN, 'rgba(1,5,7,0.14)', 0.8));
    if (legal) {
      const legalLines = wrapText(legal, 7.5, CONTENT_W - 110).slice(0, 2);
      legalLines.forEach((line, i) => {
        footer.push(block.text(MARGIN, PAGE_H - 58 + i * 10, line, { size: 7.5, color: muted }));
      });
    }
    if (settings.showPageNumbers !== false) {
      footer.push(
        block.text(PAGE_W - MARGIN - 90, PAGE_H - 58, `PAGE ${index + 1} / ${pages.length}`, {
          size: 7.5,
          font: 'mono',
          color: muted,
          align: 'right',
        }),
      );
    }
    page.blocks = page.blocks.concat(footer);
  });

  return {
    pages,
    pageCount: pages.length,
    template,
    accent,
    generatedAt: new Date().toISOString(),
    summary: {
      attachmentPages,
      attachmentCount: documents.length,
      documentsTotalPages: documentsTotalPages ?? attachmentPages,
    },
  };
}

export function pageToSvg(page, { width = 306 } = {}) {
  const height = Math.round((width / PAGE_W) * PAGE_H);
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_W} ${PAGE_H}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(page.label || 'Fax page')}">`,
  );
  parts.push('<rect width="612" height="792" fill="#ffffff"/>');

  for (const item of page.blocks) {
    if (item.type === 'rect') {
      parts.push(
        `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" fill="${escapeXml(item.fill)}"/>`,
      );
    } else if (item.type === 'rule') {
      parts.push(
        `<line x1="${item.x1}" y1="${item.y}" x2="${item.x2}" y2="${item.y}" stroke="${escapeXml(item.color)}" stroke-width="${item.width}"/>`,
      );
    } else if (item.type === 'image') {
      parts.push(
        `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" fill="#eef0f6" stroke="#d8dbe8"/>`,
      );
      parts.push(
        `<image href="/api/files/${encodeURIComponent(item.fileId)}" x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else if (item.type === 'text') {
      const anchor = item.align === 'right' ? 'end' : item.align === 'center' ? 'middle' : 'start';
      const x = item.align === 'right' ? item.x + 170 : item.x;
      const family = item.font === 'mono' ? MONO : SANS;
      parts.push(
        `<text x="${x}" y="${item.y + item.size * 0.82}" font-family="${escapeXml(family)}" font-size="${item.size}" font-weight="${item.weight}" fill="${escapeXml(item.color)}" text-anchor="${anchor}" letter-spacing="${item.tracking}">${escapeXml(item.text)}</text>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

const PDF_ESCAPES = { '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '', '\n': ' ' };
const LATIN_FALLBACK = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '•': '-',
  '€': 'EUR',
  '™': '(TM)',
  '®': '(R)',
  '©': '(c)',
  '\u00a0': ' ',
};

function pdfString(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const mapped = LATIN_FALLBACK[ch] ?? ch;
    if (mapped.codePointAt(0) > 255) out += '?';
    else out += mapped;
  }
  return out.replace(/[\\()\r\n]/g, (c) => PDF_ESCAPES[c]);
}

function hexToRgb(hex) {
  const value = String(hex || '#000000').replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6);
  const int = Number.parseInt(full || '000000', 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

function rgbaToRgb(color) {
  const value = String(color || '#000000');
  if (value.startsWith('rgba')) {
    const [r, g, b] = value.replace(/rgba?\(|\)/g, '').split(',').map((n) => Number(n.trim()));
    return [r / 255, g / 255, b / 255];
  }
  if (value.startsWith('rgb')) {
    const [r, g, b] = value.replace(/rgba?\(|\)/g, '').split(',').map((n) => Number(n.trim()));
    return [r / 255, g / 255, b / 255];
  }
  return hexToRgb(value);
}

function contentStream(page) {
  const ops = ['1 1 1 rg', `0 0 ${PAGE_W} ${PAGE_H} re f`];
  for (const item of page.blocks) {
    if (item.type === 'rect') {
      const [r, g, b] = rgbaToRgb(item.fill);
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      ops.push(`${item.x} ${PAGE_H - item.y - item.h} ${item.w} ${item.h} re f`);
    } else if (item.type === 'rule') {
      const [r, g, b] = rgbaToRgb(item.color);
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
      ops.push(`${item.width} w`);
      ops.push(`${item.x1} ${PAGE_H - item.y} m ${item.x2} ${PAGE_H - item.y} l S`);
    } else if (item.type === 'image') {
      const [r, g, b] = rgbaToRgb('#eef0f6');
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      ops.push(`${item.x} ${PAGE_H - item.y - item.h} ${item.w} ${item.h} re f`);
      ops.push('0.55 0.6 0.72 RG 0.8 w');
      ops.push(`${item.x} ${PAGE_H - item.y - item.h} ${item.w} ${item.h} re S`);
      ops.push('0.34 0.34 0.36 rg');
      ops.push('BT /F2 9 Tf');
      ops.push(
        `${item.x + 12} ${PAGE_H - item.y - 22} Tm (${pdfString(item.label || 'Attached image')}) Tj`,
      );
      ops.push('ET');
    } else if (item.type === 'text') {
      const [r, g, b] = hexToRgb(item.color);
      const font = item.font === 'mono' ? '/F3' : item.weight === 'bold' ? '/F2' : '/F1';
      const x = item.align === 'right' ? item.x + 170 - measure(item.text, item.size) : item.x;
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      ops.push('BT');
      ops.push(`${font} ${item.size} Tf`);
      ops.push(`1 0 0 1 ${x.toFixed(2)} ${(PAGE_H - item.y - item.size * 0.82).toFixed(2)} Tm`);
      ops.push(`(${pdfString(item.text)}) Tj`);
      ops.push('ET');
    }
  }
  return ops.join('\n');
}

/** Minimal, dependency-free PDF 1.4 writer (Helvetica / Courier, text + shapes). */
export function renderFaxPdf(pages, meta = {}) {
  const objects = [];
  const reserve = () => {
    objects.push('');
    return objects.length;
  };
  const setObject = (index, body) => {
    objects[index - 1] = body;
  };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontRegular = reserve();
  const fontBold = reserve();
  const fontMono = reserve();
  const infoId = reserve();

  setObject(fontRegular, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  setObject(fontBold, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  setObject(fontMono, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (const page of pages) {
    const stream = contentStream(page);
    const contentId = reserve();
    setObject(contentId, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageId = reserve();
    setObject(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R /F3 ${fontMono} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  setObject(
    pagesId,
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  setObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const created = new Date(meta.createdAt || Date.now());
  const pdfDate = created.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  setObject(
    infoId,
    `<< /Title (${pdfString(meta.title || 'Fax transmission')}) /Producer (Faxline) /CreationDate (D:${pdfDate}Z) >>`,
  );

  const header = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  let offset = Buffer.byteLength(header, 'latin1');
  const chunks = [Buffer.from(header, 'latin1')];
  const offsets = [];

  objects.forEach((body, index) => {
    const serialized = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(offset);
    offset += Buffer.byteLength(serialized, 'latin1');
    chunks.push(Buffer.from(serialized, 'latin1'));
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) {
    xref += `${String(entry).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}
