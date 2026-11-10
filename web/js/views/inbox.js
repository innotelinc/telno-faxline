import { api, icon } from '../lib.js';
import { renderFaxList } from './fax-list.js';

export async function render(ctx) {
  const result = await renderFaxList(ctx, {
    direction: 'in',
    eyebrow: 'Received',
    title: 'Inbox',
    sub: 'Inbound faxes captured on your numbers. Previews render at fax resolution and every page is downloadable as PDF.',
    actionsHtml: `<button class="btn btn--secondary" type="button" data-action="simulate">${icon('inbox', 15)} Simulate inbound</button>
      <a class="btn btn--primary" href="/send" data-link>${icon('send', 15)} New fax</a>`,
    tabs: [
      { key: 'all', label: 'All', match: () => true },
      { key: 'unread', label: 'Unread', match: (fax) => !fax.read },
      { key: 'starred', label: 'Starred', match: (fax) => fax.starred },
    ],
    emptyTitle: 'Inbox is clear',
    emptyText: 'Inbound faxes land here automatically, with unread tracking and PDF export.',
  });

  const originalMount = result.mount;
  result.mount = (root) => {
    originalMount?.(root);
    root.querySelector('[data-action="simulate"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { fax } = await api.post('/api/dev/simulate-inbound', {});
        ctx.toast.success('Inbound fax received', `${fax.recipient_name} · ${fax.pages} page(s)`);
        await ctx.reload();
      } catch (error) {
        ctx.toast.error('Could not simulate a fax', error.message);
        button.disabled = false;
      }
    });
  };
  return result;
}
