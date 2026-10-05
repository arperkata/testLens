import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: '.output',
  // Chromium refuses content-script files containing Unicode noncharacters (rrweb's CSS parser
  // embeds a literal U+FFFE). Escaping non-ASCII in the bundle avoids "It isn't UTF-8 encoded".
  vite: () => ({ esbuild: { charset: 'ascii' } }),
  manifest: {
    name: 'TestLens',
    short_name: 'TL',
    description: 'Testing flight recorder: when something goes wrong, TestLens already has the evidence. Review, then create the Jira issue.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    // One background, one configuration and one recorder for normal and Incognito windows
    // (the user still has to tick "Allow in Incognito" once on chrome://extensions).
    incognito: 'spanning',
    action: { default_title: 'TestLens — Report Issue' },
    // No global side_panel.default_path: the panel is enabled per tab (chrome.sidePanel.setOptions)
    // so it only appears on the tab where the tester opened TestLens, never in other windows.
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage', 'unlimitedStorage', 'tabs', 'webRequest', 'scripting', 'alarms', 'sidePanel', 'activeTab', 'webNavigation', 'tabCapture', 'offscreen'],
    // Host access is requested at runtime, per origin the tester chooses to monitor (plus the Jira site).
    optional_host_permissions: ['<all_urls>'],
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // Runtime-registered content scripts make WXT add their `matches` to host_permissions.
      // We request host access at runtime instead, so strip the static grant.
      delete (manifest as { host_permissions?: string[] }).host_permissions;
      delete (manifest as { web_accessible_resources?: unknown }).web_accessible_resources;
      (manifest as { content_scripts?: unknown[] }).content_scripts = [];
      // e2e builds get static localhost access so Playwright can skip the native permission prompt.
      // (<all_urls> also lets captureVisibleTab run without the activeTab grant a real toolbar click provides.)
      if (process.env.TL_E2E === '1') (manifest as { host_permissions?: string[] }).host_permissions = ['<all_urls>'];
      (manifest as { options_ui?: { page: string; open_in_tab?: boolean } }).options_ui = { page: 'options.html', open_in_tab: true };
      // WXT registers sidepanel.html globally; we enable it per tab at runtime instead.
      delete (manifest as { side_panel?: unknown }).side_panel;
      const m = manifest as { icons?: Record<string, string>; action?: Record<string, unknown> };
      if (m.icons && m.action) m.action.default_icon = { '16': m.icons['16'], '32': m.icons['32'], '48': m.icons['48'], '128': m.icons['128'] };
    },
  },
});
