#!/usr/bin/env node
// Runs the TypeScript server directly via tsx so the Hub needs no build step.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'src', 'server.ts');
const child = spawn(process.execPath, ['--import', 'tsx', server], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
