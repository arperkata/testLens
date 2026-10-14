#!/usr/bin/env node
// Repo-local launcher: runs the built single file when present, otherwise the TypeScript source via tsx.
// (The published npm package points its bin straight at dist/testlens-hub.mjs.)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'testlens-hub.mjs');
const args = existsSync(dist) ? [dist] : ['--import', 'tsx', path.join(here, '..', 'src', 'server.ts')];
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
