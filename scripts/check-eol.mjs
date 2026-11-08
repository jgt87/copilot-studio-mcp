// Line-ending check (docs/12-line-endings.md). Read-only; uses `git ls-files --eol`.
//
//   node scripts/check-eol.mjs            fail on CRLF or mixed text in the index,
//                                         and on mixed files in the working tree
//   node scripts/check-eol.mjs --strict   also fail when a working-tree file's
//                                         endings differ from its eol attribute
//
// Run it in CI and before a release; a project that has added the shared
// .gitattributes passes --strict after one clean checkout.
import { execFileSync } from 'node:child_process';

const strict = process.argv.includes('--strict');
const out = execFileSync('git', ['ls-files', '--eol'], { encoding: 'utf8', maxBuffer: 1 << 28 });

const problems = [];
for (const line of out.split('\n')) {
  const m = line.match(/^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\t(.*)$/);
  if (!m) continue;
  const [, index, work, attr, file] = m;
  if (index === '-text' || attr.includes('-text')) continue;
  if (index === 'crlf' || index === 'mixed') problems.push(`index ${index}: ${file}`);
  if (work === 'mixed') problems.push(`working tree mixed: ${file}`);
  const want = attr.match(/eol=(lf|crlf)/)?.[1];
  if (strict && want && (work === 'lf' || work === 'crlf') && work !== want) {
    problems.push(`working tree ${work}, attribute eol=${want}: ${file}`);
  }
}

if (problems.length) {
  console.error(`line endings: ${problems.length} problem(s)`);
  problems.slice(0, 50).forEach((p) => console.error(`  ${p}`));
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  console.error('Fix: normalize the file to its eol (LF unless .gitattributes says crlf), then `git add --renormalize .`.');
  process.exitCode = 1;
} else {
  console.log(`line endings: ok${strict ? ' (strict)' : ''}`);
}
