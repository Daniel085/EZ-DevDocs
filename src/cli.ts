#!/usr/bin/env node
// Command line. All file access for the module happens here.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, summarize, GenerationError } from './generate.ts';
import { loadSpec, SpecError } from './spec.ts';
import { validateBundle, type BundleFiles } from './validate.ts';

const USAGE = `Usage:
  ez-devdocs generate <spec> [--out <dir>] [--no-timestamp] [--json]
      Writes <dir>/guides (the bundle), <dir>/report.json and <dir>/spec-audit.md.
      Default <dir> is ./out.
  ez-devdocs validate <bundle-dir> --spec <spec> [--json]
      Checks an existing bundle against the contract.

Exit code is 0 when the bundle is valid, 1 when it is not, 2 on a usage or input error.`;

const manifestSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'guides-manifest.schema.json'), 'utf8'));

function readBundle(dir: string): BundleFiles {
  const files: BundleFiles = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !['--out', '--spec'].includes(rest[i - 1] ?? ''));
  const json = flags.has('--json');

  if (command === 'generate' && positional[0]) {
    const out = resolve(option('--out') ?? 'out');
    const result = generate(readFileSync(positional[0]), {
      manifestSchema,
      generatedAt: flags.has('--no-timestamp') ? undefined : new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    });
    const bundleDir = join(out, 'guides');
    rmSync(bundleDir, { recursive: true, force: true });
    for (const [path, bytes] of result.files) {
      const full = join(bundleDir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    writeFileSync(join(out, 'report.json'), JSON.stringify(result.report, null, 2) + '\n');
    writeFileSync(join(out, 'spec-audit.md'), result.auditMarkdown);
    process.stdout.write(json ? JSON.stringify(result.report, null, 2) + '\n' : summarize(result.report) + `\nBundle: ${bundleDir}\nReport: ${join(out, 'report.json')}\nAudit:  ${join(out, 'spec-audit.md')}\n`);
    return result.report.validation.ok ? 0 : 1;
  }
  if (command === 'validate' && positional[0] && option('--spec')) {
    const report = validateBundle(readBundle(resolve(positional[0])), loadSpec(readFileSync(option('--spec')!)), { manifestSchema });
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      for (const f of [...report.errors, ...report.warnings]) process.stdout.write(`${f.severity.padEnd(7)} ${f.file}${f.line ? ':' + f.line : ''} ${f.code}: ${f.message}\n`);
      process.stdout.write(`${report.ok ? 'Valid' : 'Invalid'}: ${report.errors.length} errors, ${report.warnings.length} warnings\n`);
    }
    return report.ok ? 0 : 1;
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof SpecError || e instanceof GenerationError || (e as NodeJS.ErrnoException).code === 'ENOENT') {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exitCode = 2;
  } else throw e;
}
