import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

it('VERSION comes from package.json', () => {
  expect(VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});
