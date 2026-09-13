import { extractPosting } from '../src/extract';
import { fillForm } from '../src/fill';
import { onMessage, sendMessage } from '../src/messaging';
import { scanForm } from '../src/scan';
import { clickSubmit, confirmationText, waitForConfirmation } from '../src/submit';

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
    onMessage('submit', async ({ data }) => {
      const result = clickSubmit(document, location.href, data);
      if (result.finalClicked && !result.submitted) {
        const confirmation = await waitForConfirmation(document, location.href);
        if (confirmation) {
          return {
            ...result,
            submitted: true,
            confirmationText: confirmation,
            url: location.href,
          };
        }
      }
      return result;
    });

    const report = () => {
      try {
        const posting = extractPosting(document, location.href);
        void sendMessage('pageReady', { posting, tabUrl: location.href });
      } catch {
        /* page may be mid-navigation */
      }
    };

    // Dynamic ATS pages often hydrate after document_idle. Retry extraction without requiring
    // a URL change so a Workday/Ashby page is not incorrectly left at "loading".
    for (const delay of [0, 1200, 3500, 7000]) setTimeout(report, delay);

    const initialConfirmation = confirmationText(document, location.href);
    if (initialConfirmation) {
      void sendMessage('manualSubmissionDetected', {
        confirmationText: initialConfirmation,
        url: location.href,
      });
    }
    document.addEventListener(
      'click',
      (event) => {
        const el = event.target instanceof Element ? event.target.closest('button, input[type="submit"]') : null;
        const label = `${el?.textContent ?? ''} ${el?.getAttribute('aria-label') ?? ''} ${el?.getAttribute('value') ?? ''}`;
        if (!/\b(submit|send|complete)\b.*\b(application)?\b/i.test(label)) return;
        void waitForConfirmation(document, location.href, 15_000).then((confirmation) => {
          if (!confirmation) return;
          void sendMessage('manualSubmissionDetected', {
            confirmationText: confirmation,
            url: location.href,
          });
        });
      },
      true,
    );

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
