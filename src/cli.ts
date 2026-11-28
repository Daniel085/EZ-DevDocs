#!/usr/bin/env node
// Command line. All file access for the module happens here.

import { existsSync, mkdirSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ROLES, inventoryExtensions, type ExtensionRole, type Settings } from './extensions.ts';
import { generate, summarize, GenerationError } from './generate.ts';
import { loadSpec, SpecError } from './spec.ts';
import { validateBundle, type BundleFiles } from './validate.ts';

const USAGE = `Usage:
  ez-devdocs generate <spec> [--out <dir>] [--existing <bundle-dir>] [--settings <file>] [--ask]
                             [--timestamp] [--json]
      Writes <dir>/guides (the bundle, with its report.json) and <dir>/spec-audit.md.
      Default <dir> is ./out. <spec> is the published spec, read as bytes.
      --existing  the bundle as it stands where people edit it. Pages a person changed
                  are kept as they are.
      --settings  a JSON file of choices for this build: what to do with each vendor
                  extension (x- field) in the spec. Without a role, an extension is listed
                  in the report and shown on no page.
      --ask       before generating, asks about each extension the settings do not decide,
                  and writes the answers to the --settings file.
      --timestamp adds generatedAt to the manifest. Without it, output is byte-identical
                  from run to run.
  ez-devdocs validate <bundle-dir> --spec <spec> [--json]
      Checks an existing bundle against the contract.

Exit code is 0 when the bundle is valid, 1 when it is not, 2 on a usage or input error.`;

const contractFile = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'contract', name), 'utf8'));
const manifestSchema = contractFile('guides-manifest.schema.json');
const reportSchema = contractFile('guides-report.schema.json');

/**
 * Asks a person, on the terminal, what to do with each vendor extension the settings do not
 * decide. Answers are read a line at a time from standard input.
 */
function ask(model: ReturnType<typeof loadSpec>, settings: Settings): Settings {
  const out: Settings = { ...settings, extensions: { ...(settings.extensions ?? {}) } };
  const undecided = inventoryExtensions(model, settings).filter((e) => !e.role);
  if (undecided.length === 0) {
    process.stdout.write('Every vendor extension in this spec already has a role in the settings.\n');
    return out;
  }
  // One line at a time, so a prompt is answered before the next is shown.
  const readLine = (): string => {
    const byte = Buffer.alloc(1);
    const bytes: number[] = [];
    while (true) {
      let n = 0;
      try {
        n = readSync(0, byte, 0, 1, null);
      } catch {
        n = 0;
      }
      if (n === 0 || byte[0] === 10) break;
      bytes.push(byte[0]!);
    }
    return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
  };
  process.stdout.write(`This spec has ${undecided.length} vendor extension${undecided.length > 1 ? 's' : ''} the settings do not decide.\nRoles: permission (a line on each step and a permissions page), requires (a line on each step),\nnote (its text on each step), errors (builds the errors page), ignore.\n`);
  for (const e of undecided) {
    // The name and sample are spec text: shown with control characters removed, never acted on.
    const clean = (t: string) => t.replace(/[^\x20-\x7E]/g, '?');
    const usable = e.where.includes('operation') && e.shapes.every((x) => x !== 'object' && x !== 'null');
    process.stdout.write(`\n${clean(e.name)}: ${e.count} uses, on ${e.where.join(', ')}; values are ${e.shapes.join(' or ')}.\n  For example: ${clean(e.sample)}\n`);
    if (!usable) {
      // A page shows only text written on an operation. Anything else can only be ignored.
      process.stdout.write(`  ${e.where.includes('operation') ? 'Its value is not text' : 'It is not written on operations'}, so a page cannot show it. Recorded as: ignore\n`);
      out.extensions![e.name] = { role: 'ignore' };
      continue;
    }
    const fallback: ExtensionRole = e.suggestedRole ?? 'ignore';
    process.stdout.write(`  Role [${fallback}]: `);
    const answer = readLine().trim().toLowerCase();
    const role: ExtensionRole = (EXTENSION_ROLES as string[]).includes(answer) ? (answer as ExtensionRole) : fallback;
    if (answer && role !== answer) process.stdout.write(`  '${clean(answer)}' is not a role. Recorded as: ${fallback}\n`);
    out.extensions![e.name] = { role };
    if (role !== 'ignore' && role !== 'errors') {
      process.stdout.write('  Words to show before its value (Enter for the default): ');
      const label = readLine().trim();
      if (label) out.extensions![e.name]!.label = label.slice(0, 80);
    }
  }
  return out;
}

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
  const positional = rest.filter((a, i) => !a.startsWith('--') && !['--out', '--spec', '--existing', '--settings'].includes(rest[i - 1] ?? ''));
  const json = flags.has('--json');

  if (command === 'generate' && positional[0]) {
    const out = resolve(option('--out') ?? 'out');
    const existingDir = option('--existing');
    const settingsFile = option('--settings');
    let settings: Settings | undefined = settingsFile && existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : undefined;
    if (settingsFile && !existsSync(settingsFile) && !flags.has('--ask')) throw new SpecError(`No settings file at ${settingsFile}. Pass --ask to create it.`);
    if (flags.has('--ask')) {
      if (!settingsFile) throw new SpecError('--ask needs --settings <file>, to write the answers to.');
      settings = ask(loadSpec(readFileSync(positional[0])), settings ?? {});
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      process.stdout.write(`Settings written to ${settingsFile}\n\n`);
    }
    const result = generate(readFileSync(positional[0]), {
      settings,
      manifestSchema,
      reportSchema,
      generatedAt: flags.has('--timestamp') ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : undefined,
      existing: existingDir ? readBundle(resolve(existingDir)) : undefined,
    });
    const bundleDir = join(out, 'guides');
    rmSync(bundleDir, { recursive: true, force: true });
    for (const [path, bytes] of result.files) {
      const full = join(bundleDir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    writeFileSync(join(out, 'spec-audit.md'), result.auditMarkdown);
    process.stdout.write(json ? JSON.stringify({ report: result.report, validation: result.validation }, null, 2) + '\n' : summarize(result.report, result.validation) + `\nBundle: ${bundleDir}\nReport: ${join(bundleDir, 'report.json')}\nAudit:  ${join(out, 'spec-audit.md')}\n`);
    return result.validation.ok ? 0 : 1;
  }
  if (command === 'validate' && positional[0] && option('--spec')) {
    const report = validateBundle(readBundle(resolve(positional[0])), loadSpec(readFileSync(option('--spec')!)), { manifestSchema, reportSchema });
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      for (const f of report.findings) process.stdout.write(`${f.severity.padEnd(7)} ${f.file}${f.line ? ':' + f.line : ''} ${f.code}: ${f.message}\n`);
      const n = (sev: string) => report.findings.filter((f) => f.severity === sev).length;
      process.stdout.write(`${report.ok ? 'Valid' : 'Invalid'}: ${n('error')} errors, ${n('blocker')} blockers, ${n('warning')} warnings\n`);
      if (report.withheld.length) process.stdout.write(`Withheld from publishing: ${report.withheld.join(', ')}\n`);
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
