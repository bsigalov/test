#!/usr/bin/env node

/**
 * Reads git log and generates public/releases.json
 * Run: node scripts/generate-releases.js
 *
 * Each commit becomes a release entry. The version is auto-incremented
 * based on commit order (1.0.0, 1.1.0, 1.2.0, ...).
 * The current (latest) version is also written to public/version.json.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

// Get git log: hash|subject|author date ISO
const log = execSync(
  'git log --format="%H|%s|%aI" --reverse',
  { encoding: 'utf-8' }
).trim();

if (!log) {
  console.error('No git commits found');
  process.exit(1);
}

const commits = log.split('\n').map((line) => {
  const [hash, subject, date] = line.split('|');
  return { hash, subject, date };
});

// Skip the very first "initial commit" if it's empty scaffolding
const meaningful = commits.filter(
  (c) => c.subject.toLowerCase() !== 'initial commit'
);

// Generate version numbers: 1.0.0, 1.1.0, 1.2.0, ...
const releases = meaningful.map((commit, index) => {
  const minor = index;
  const version = `1.${minor}.0`;

  // Try to extract bullet-point changes from commit body
  let changes;
  try {
    const body = execSync(`git log -1 --format="%b" ${commit.hash}`, {
      encoding: 'utf-8',
    }).trim();
    if (body) {
      changes = body
        .split('\n')
        .filter((l) => l.startsWith('- ') || l.startsWith('* '))
        .map((l) => l.replace(/^[-*]\s*/, ''));
    }
  } catch {
    // ignore
  }

  // Fallback: use subject as the single change
  if (!changes || changes.length === 0) {
    changes = [commit.subject];
  }

  return {
    version,
    date: commit.date,
    title: commit.subject,
    changes,
    hash: commit.hash.substring(0, 7),
  };
});

// Reverse so latest is first
releases.reverse();

const latestVersion = releases[0]?.version || '1.0.0';

// Write releases.json
fs.writeFileSync(
  path.join(publicDir, 'releases.json'),
  JSON.stringify({ version: latestVersion, releases }, null, 2)
);

console.log(
  `Generated releases.json: v${latestVersion} (${releases.length} releases)`
);
