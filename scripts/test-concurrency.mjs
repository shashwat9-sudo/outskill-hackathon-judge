#!/usr/bin/env node
/**
 * Run the queue concurrency proof against a real Postgres server.
 *
 * The rest of the test suite runs on PGlite, which is a genuine Postgres engine
 * but a single-connection one. "Two workers never claim the same job" cannot be
 * demonstrated on a single connection — there is no second transaction to run —
 * so that proof needs a real multi-connection server.
 *
 * This boots a throwaway one, runs the proof, and tears it down.
 *
 *   npm run test:concurrency
 *
 * If you already have a Postgres you do not mind truncating:
 *
 *   TEST_DATABASE_URL=postgres://localhost:5432/ohj_test npm run test:concurrency
 *
 * The server binaries are ~146MB, which is too much to put in every install, so
 * they are fetched on demand the first time this script runs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = process.env.OHJ_PG_PORT ?? '54329';
const PACKAGE = '@embedded-postgres/darwin-arm64';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function runTest(connectionString) {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', 'packages/shared/src/data/postgres/assessment-concurrency.test.ts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: connectionString },
    },
  );
  return result.status ?? 1;
}

// Already have a server: use it and change nothing.
if (process.env.TEST_DATABASE_URL) {
  log('Using TEST_DATABASE_URL from the environment.');
  process.exit(runTest(process.env.TEST_DATABASE_URL));
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  log(
    `This helper only knows how to fetch binaries for darwin-arm64 (this is ${process.platform}-${process.arch}).\n` +
      'Start any Postgres yourself and re-run with TEST_DATABASE_URL set.',
  );
  process.exit(1);
}

const binDir = join(ROOT, 'node_modules', PACKAGE, 'native', 'bin');

if (!existsSync(join(binDir, 'initdb'))) {
  log(`Fetching a throwaway Postgres (${PACKAGE}, ~146MB, first run only)…`);
  execFileSync('npm', ['install', '-D', '--no-save', 'embedded-postgres'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

// The Unix socket path has a 103-byte limit and the scratch directory blows
// through it, so the socket lives somewhere short and connections use TCP.
const dataDir = join(tmpdir(), 'ohj-pg-data');
const socketDir = join(tmpdir(), 'ohjpg');
const logFile = join(tmpdir(), 'ohj-pg.log');

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(socketDir, { recursive: true });

log('Initialising a throwaway cluster…');
execFileSync(join(binDir, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], {
  stdio: 'ignore',
});

log(`Starting Postgres on port ${PORT}…`);
execFileSync(
  join(binDir, 'pg_ctl'),
  ['-D', dataDir, '-l', logFile, '-o', `-p ${PORT} -k ${socketDir}`, '-w', 'start'],
  { stdio: 'inherit' },
);

let status = 1;
try {
  const { Client } = await import('pg');
  const admin = new Client({ host: '127.0.0.1', port: Number(PORT), user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query('drop database if exists ohj_test');
  await admin.query('create database ohj_test');
  await admin.end();

  status = runTest(`postgres://postgres@127.0.0.1:${PORT}/ohj_test`);
} finally {
  log('Stopping Postgres…');
  spawnSync(join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(status);
