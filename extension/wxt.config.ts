import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const protocolPath = fileURLToPath(new URL('../agent/src/protocol.ts', import.meta.url));

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: 'AI Job Search Autopilot',
    description: 'Detects job postings, tailors your CV and cover letter through your local Claude Code workspace, fills and submits applications, tracks them, and drafts referral outreach.',
    permissions: ['storage', 'tabs', 'activeTab', 'sidePanel', 'scripting', 'alarms', 'notifications', 'clipboardWrite'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', '<all_urls>'],
    action: { default_title: 'AI Job Search Autopilot' },
    side_panel: { default_path: 'sidepanel.html' },
    options_ui: { page: 'options.html', open_in_tab: true },
    minimum_chrome_version: '116',
  },
  vite: () => ({
    resolve: {
      alias: {
        '@protocol': protocolPath,
      },
    },
    server: { fs: { allow: ['..'] } },
  }),
});
