/**
 * Read-only Supabase Storage connectivity check.
 *
 * Lists buckets and their contents. It uploads nothing, modifies nothing and
 * deletes nothing, and it never prints the secret key.
 *
 * The last section is the one worth having: it scans the built client bundle
 * for the key, because the single worst outcome here is a server-only
 * credential reaching a browser.
 *
 *   npx tsx scripts/verify-storage.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && match[2]) env[match[1] as string] = match[2].trim();
  }
  return env;
}

const pass = (label: string, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail = '') => console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label: string, detail = '') => console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''}`);

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) pass(label, detail);
  else {
    fail(label, detail);
    failures += 1;
  }
}

/** The six buckets migration 0003 creates, with the limits it sets. */
const EXPECTED = [
  { id: 'submission-decks', limit: 26_214_400, mime: ['application/pdf'] },
  { id: 'submission-screenshots', limit: 10_485_760, mime: ['image/png', 'image/jpeg', 'image/webp'] },
  { id: 'browser-evidence', limit: 52_428_800, mime: null },
  { id: 'traces', limit: 209_715_200, mime: ['application/zip'] },
  { id: 'internal-reports', limit: 26_214_400, mime: null },
  { id: 'admin-resources', limit: 52_428_800, mime: null },
] as const;

interface BucketRow {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

async function main() {
  const env = loadEnvFile('.env.local');
  const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  const url = env.SUPABASE_URL;

  console.log('\n=== 1. The key is present and correctly shaped ===');
  check(Boolean(env.SUPABASE_SECRET_KEY), 'SUPABASE_SECRET_KEY is set');
  check(Boolean(url), 'SUPABASE_URL is set');

  if (!key || !url) {
    console.log('\n❌ Cannot continue without both values.\n');
    process.exit(1);
  }

  // Shape only. The value is never printed.
  const isCurrentFormat = key.startsWith('sb_secret_');
  const isLegacyJwt = key.startsWith('eyJ');
  check(
    isCurrentFormat || isLegacyJwt,
    'key has a recognised format',
    isCurrentFormat ? 'sb_secret_… (current)' : isLegacyJwt ? 'JWT (legacy service_role)' : 'unrecognised',
  );
  if (isLegacyJwt) {
    warn(
      'this is the legacy service_role key',
      'accepted as a fallback, but a new deployment should use the sb_secret_ key',
    );
  }
  check(!key.startsWith('sb_publishable_'), 'is not the publishable (browser) key');
  console.log(`  ·  length — ${key.length} characters`);

  console.log('\n=== 2. Storage API reachable ===');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const started = Date.now();
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error || !buckets) {
    fail('listed buckets', error?.message ?? 'no data returned');
    console.log(
      '\n❌ Storage is not reachable. If this says "Invalid API key", the value in ' +
        'SUPABASE_SECRET_KEY is not a server key for this project.\n',
    );
    process.exit(1);
  }
  pass('listed buckets', `${Date.now() - started} ms`);

  console.log('\n=== 3. The six expected buckets ===');
  const found = new Map((buckets as BucketRow[]).map((b) => [b.id, b]));
  for (const expected of EXPECTED) {
    const bucket = found.get(expected.id);
    if (!bucket) {
      check(false, expected.id, 'MISSING');
      continue;
    }
    const limitOk = bucket.file_size_limit === expected.limit;
    check(
      !bucket.public && limitOk,
      expected.id,
      `${bucket.public ? 'PUBLIC — must be private' : 'private'}, limit ${
        bucket.file_size_limit === null ? 'none' : `${Math.round(bucket.file_size_limit / 1_048_576)} MB`
      }${limitOk ? '' : ` (expected ${Math.round(expected.limit / 1_048_576)} MB)`}`,
    );
  }

  const unexpected = [...found.keys()].filter((id) => !EXPECTED.some((e) => e.id === id));
  check(unexpected.length === 0, 'no unexpected buckets', unexpected.join(', ') || 'none');

  const publicBuckets = (buckets as BucketRow[]).filter((b) => b.public);
  check(publicBuckets.length === 0, 'no bucket is public', `${publicBuckets.length} public`);

  console.log('\n=== 4. Each bucket is reachable by the server adapter ===');
  let objectsSeen = 0;
  for (const expected of EXPECTED) {
    // `list` is a read. Nothing is created, modified or removed.
    const { data, error: listError } = await client.storage.from(expected.id).list('', { limit: 5 });
    if (listError) {
      check(false, expected.id, listError.message);
      continue;
    }
    const count = data?.length ?? 0;
    objectsSeen += count;
    pass(expected.id, count === 0 ? 'reachable, empty' : `reachable, ${count} object(s)`);
  }
  check(objectsSeen === 0, 'no objects stored yet', `${objectsSeen} found`);

  console.log('\n=== 5. The key has not leaked into the client bundle ===');
  // The worst possible outcome here. Checked rather than assumed.
  const buildDir = 'apps/web/.next';
  if (!existsSync(buildDir)) {
    warn('no build to scan', 'run the web build, then re-run this check');
  } else {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const info = statSync(full);
        if (info.isDirectory()) {
          if (entry !== 'cache') walk(full);
        } else if (/\.(js|json|html|txt|map)$/.test(entry) && info.size < 20_000_000) {
          if (readFileSync(full, 'utf8').includes(key)) hits.push(full);
        }
      }
    };
    walk(buildDir);
    check(hits.length === 0, 'secret key absent from every build artifact', hits.join(', ') || 'clean');

    const staticDir = join(buildDir, 'static');
    if (existsSync(staticDir)) {
      const clientHits: string[] = [];
      const walkClient = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walkClient(full);
          else if (entry.endsWith('.js') && readFileSync(full, 'utf8').includes(key)) {
            clientHits.push(full);
          }
        }
      };
      walkClient(staticDir);
      check(clientHits.length === 0, 'absent from browser-served JavaScript', clientHits.join(', ') || 'clean');
    }
  }

  console.log('\n=== 6. Nothing was written ===');
  pass('no upload, update or delete was attempted', 'listBuckets and list only');

  console.log(
    failures === 0
      ? '\n✅ Storage connectivity passed. All six buckets reachable and private.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
