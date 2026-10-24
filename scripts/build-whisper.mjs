// Builds the whisper.cpp CLI and server for this platform into
// vendor/whisper/<os>-<arch>. Needs git, cmake, and a C++ toolchain.
// Produces static binaries, so no shared libraries have to travel with them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 'v1.9.5';
const root = path.resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const outDir = path.join(
  root,
  'vendor',
  'whisper',
  `${process.platform}-${process.arch}`,
);
const binaries = ['whisper-cli', 'whisper-server'].map(
  (name) => `${name}${exe}`,
);

if (
  binaries.every((file) => fs.existsSync(path.join(outDir, file))) &&
  !process.argv.includes('--force')
) {
  console.log(
    `whisper.cpp ${VERSION} is already at ${path.relative(root, outDir)}`,
  );
  process.exit(0);
}

const source = path.join(os.tmpdir(), `lilt-whisper-${VERSION}`);
if (!fs.existsSync(path.join(source, '.git'))) {
  fs.rmSync(source, { recursive: true, force: true });
  execFileSync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      VERSION,
      'https://github.com/ggml-org/whisper.cpp',
      source,
    ],
    { stdio: 'inherit' },
  );
}

execFileSync(
  'cmake',
  [
    '-B',
    path.join(source, 'build'),
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
  ],
  { stdio: 'inherit', cwd: source },
);
execFileSync(
  'cmake',
  [
    '--build',
    path.join(source, 'build'),
    '--config',
    'Release',
    '-j',
    String(os.availableParallelism()),
    '--target',
    ...binaries.map((file) => file.replace(/\.exe$/, '')),
  ],
  { stdio: 'inherit' },
);

fs.mkdirSync(outDir, { recursive: true });
for (const file of binaries) {
  const built = [
    path.join(source, 'build', 'bin', file),
    path.join(source, 'build', 'bin', 'Release', file),
  ].find((candidate) => fs.existsSync(candidate));
  if (!built) throw new Error(`The build did not produce ${file}.`);
  const target = path.join(outDir, file);
  fs.copyFileSync(built, target);
  fs.chmodSync(target, 0o755);
  console.log(`whisper.cpp ${VERSION} -> ${path.relative(root, target)}`);
}
