// Detached delivery helper for newman-reporter-testlens: posts queued payloads to the Hub, then exits.
'use strict';
const fs = require('node:fs');
const file = process.argv[2];
(async () => {
  const { hub, payloads } = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const p of payloads) {
    try {
      await fetch(`${hub}/ingest/postman`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    } catch (_) {
      /* hub down; nothing else to do from a detached process */
    }
  }
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* ignore */
  }
})();
