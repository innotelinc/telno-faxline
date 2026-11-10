import { icon } from '../lib.js';
import { renderFaxList } from './fax-list.js';

export async function render(ctx) {
  return renderFaxList(ctx, {
    direction: 'out',
    eyebrow: 'Transmissions',
    title: 'Outbox',
    sub: 'Every outgoing fax with carrier state, retry budget and rendered pages. Rows update live as the provider reports back.',
    actionsHtml: `<a class="btn btn--primary" href="/send" data-link>${icon('send', 15)} New fax</a>`,
    tabs: [
      { key: 'all', label: 'All', match: () => true },
      { key: 'delivered', label: 'Delivered', match: (fax) => fax.status === 'delivered' },
      { key: 'sending', label: 'In flight', match: (fax) => ['queued', 'sending'].includes(fax.status) },
      { key: 'scheduled', label: 'Scheduled', match: (fax) => fax.status === 'scheduled' },
      { key: 'failed', label: 'Failed', match: (fax) => ['failed', 'cancelled'].includes(fax.status) },
    ],
    emptyTitle: 'No transmissions yet',
    emptyText: 'Compose a fax and it will appear here with a live delivery timeline.',
  });
}
