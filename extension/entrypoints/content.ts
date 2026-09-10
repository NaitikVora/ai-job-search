import { extractPosting } from '../src/extract';
import { fillForm } from '../src/fill';
import { onMessage, sendMessage } from '../src/messaging';
import { scanForm } from '../src/scan';
import { clickSubmit } from '../src/submit';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    onMessage('detect', () => {
      const posting = extractPosting(document, location.href);
      return { posting, reason: posting ? undefined : 'could not extract a job posting from this page' };
    });
    onMessage('scan', () => scanForm(document, location.href));
    onMessage('fill', ({ data }) => fillForm(document, data));
    onMessage('submit', ({ data }) => clickSubmit(document, location.href, data));

    const report = () => {
      try {
        const posting = extractPosting(document, location.href);
        void sendMessage('pageReady', { posting, tabUrl: location.href });
      } catch {
        /* page may be mid-navigation */
      }
    };

    report();
    let last = location.href;
    const mo = new MutationObserver(() => {
      if (location.href !== last) {
        last = location.href;
        setTimeout(report, 800);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', () => setTimeout(report, 400));
  },
});
