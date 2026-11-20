import { createRequire } from 'node:module';

// Read at runtime so package.json is the only place the version lives (release-please bumps it).
// This file runs from src/ in tests and from dist/ once built; both are one level below the package root.
const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;
