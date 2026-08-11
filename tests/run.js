/**
 * run.js — entry point: `npm test`.
 *
 * Test files are imported for their side effects (describe/it registration),
 * then the harness runs everything it collected.
 */

import { run } from './harness.js';

await import('./confirm-token.test.js');
await import('./zip-inspect.test.js');
await import('./query-guard.test.js');
await import('./deploy.integration.test.js');

const ok = await run();
if (!ok) process.exitCode = 1;
