// Builds the live transcription helper (tools/transcribe-stream) into
// vendor/transcribe/<os>-<arch>. Needs cargo and a C++ toolchain; the helper
// builds transcribe.cpp from source, so the binary links nothing at runtime.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const crate = path.join(root, 'tools', 'transcribe-stream');
const exe = process.platform === 'win32' ? '.exe' : '';
const name = `transcribe-stream${exe}`;
const outDir = path.join(
  root,
  'vendor',
  'transcribe',
  `${process.platform}-${process.arch}`,
);
const target = path.join(outDir, name);

if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log(`transcribe-stream is already at ${path.relative(root, target)}`);
  process.exit(0);
}

execFileSync('cargo', ['build', '--release', '--offline'], {
  stdio: 'inherit',
  cwd: crate,
});

const built = path.join(crate, 'target', 'release', name);
if (!fs.existsSync(built)) throw new Error('The build did not produce a helper.');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, target);
fs.chmodSync(target, 0o755);
console.log(`transcribe-stream -> ${path.relative(root, target)}`);
