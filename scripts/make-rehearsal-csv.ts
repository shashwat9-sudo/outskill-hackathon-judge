/**
 * A cohort-shaped CSV, containing nobody.
 *
 * The rehearsal needs to feel like the real thing — sixty-odd groups, uneven
 * team sizes, the occasional one-person group — because the interesting
 * failures at that scale are about volume and edge cases, not about any one
 * team. It must equally contain no learner: every address is `@example.com`,
 * reserved by RFC 2606 precisely so test data can never reach a real inbox, and
 * every name is assembled from two word lists.
 *
 * Written to a file for the operator to import through the admin interface by
 * hand. It deliberately does not touch the database: creating the cohort is the
 * flow being rehearsed.
 *
 *   npx tsx scripts/make-rehearsal-csv.ts [outputPath]
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(homedir(), 'Desktop', 'rehearsal-learners.csv');

/**
 * Deterministic, so two runs produce the same cohort.
 *
 * A rehearsal that differs every time cannot be compared with the last one, and
 * `Math.random()` would make "did that group exist yesterday?" unanswerable.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — small, and good enough to shuffle names.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

const FIRST = [
  'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Ishita', 'Kabir', 'Meera', 'Rohan', 'Saanvi',
  'Aditya', 'Kavya', 'Nikhil', 'Priya', 'Rahul', 'Sneha', 'Varun', 'Tara', 'Yash', 'Zara',
  'Imran', 'Fatima', 'Joseph', 'Grace', 'Daniel', 'Leah', 'Samuel', 'Nora', 'Omar', 'Layla',
];

const LAST = [
  'Sharma', 'Iyer', 'Nair', 'Patel', 'Reddy', 'Bose', 'Khan', 'Menon', 'Gupta', 'Rao',
  'Fernandes', 'Dsouza', 'Kaur', 'Singh', 'Joshi', 'Malhotra', 'Pillai', 'Chatterjee',
];

/**
 * How big a group is.
 *
 * Weighted to look like a real allocation rather than a uniform draw: most
 * groups are three or four, a few are pairs, and one or two people end up
 * alone. The lone learner is the case worth having in a rehearsal — a
 * one-person "team" is where copy written for a group reads oddly.
 */
const SIZES = [1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 6];

function main() {
  const random = makeRandom(20260817);
  const groupCount = 67;

  const rows: string[][] = [['Group Number', 'Learner Name', 'Learner Email', 'WhatsApp Link']];
  const used = new Set<string>();
  let learners = 0;

  for (let index = 0; index < groupCount; index += 1) {
    // 101 upwards: clear of the 8xx and 9xx numbers the synthetic test cohorts
    // use, so nothing here can be mistaken for one of those, and clear of the
    // single- and double-digit numbers a real allocation starts at.
    const groupNumber = 101 + index;
    const size = SIZES[Math.floor(random() * SIZES.length)]!;

    for (let member = 0; member < size; member += 1) {
      let name = '';
      // Names repeat across a cohort of 250 in reality; addresses must not.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = `${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]}`;
        if (!used.has(`${groupNumber}:${candidate}`)) {
          used.add(`${groupNumber}:${candidate}`);
          name = candidate;
          break;
        }
      }
      if (!name) name = `Learner ${groupNumber}-${member + 1}`;

      const email = `g${groupNumber}.${member + 1}@example.com`;
      // A harmless placeholder, on a domain reserved for documentation. It is
      // shaped like the real thing so the import and the sheet can be checked,
      // and it leads nowhere.
      const whatsapp = `https://chat.example.com/rehearsal/group-${groupNumber}`;

      rows.push([String(groupNumber), name, email, whatsapp]);
      learners += 1;
    }
  }

  const csv = rows
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\r\n');

  writeFileSync(OUT, `${csv}\r\n`, { mode: 0o600 });

  // A last check rather than a promise: no address outside example.com, and
  // nothing that looks like a real contact.
  const offenders = rows.slice(1).filter((row) => !row[2]!.endsWith('@example.com'));
  if (offenders.length > 0) throw new Error(`${offenders.length} rows are not @example.com`);

  console.log(`  ✅ ${groupCount} groups, ${learners} learners, all @example.com`);
  console.log(`  · group numbers ${101}–${100 + groupCount}`);
  console.log(`  · team sizes ${Math.min(...SIZES)}–${Math.max(...SIZES)}`);
  console.log(`  · written to ${OUT}`);
}

main();
