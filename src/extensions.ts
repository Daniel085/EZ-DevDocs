// Vendor extensions: the `x-` fields a spec carries beyond OpenAPI. They have no declared meaning,
// so nothing here guesses one. Every extension is found and reported. It reaches a page only when
// the settings for a build give it a role. Pure.

import type { Json, Operation, SpecModel } from './spec.ts';

/** What a build can do with an extension. */
export type ExtensionRole = 'permission' | 'requires' | 'note' | 'errors' | 'ignore';
export const EXTENSION_ROLES: ExtensionRole[] = ['permission', 'requires', 'note', 'errors', 'ignore'];

export interface ExtensionSetting {
  role: ExtensionRole;
  /** The words shown before the value on a page. Each role has a default. */
  label?: string;
}

export interface Settings {
  /** By extension name, for example `x-required-permission`. */
  extensions?: Record<string, ExtensionSetting>;
}

export interface ExtensionInfo {
  name: string;
  /** How many times it appears in the document. */
  count: number;
  /** Where: `operation`, `parameter`, `request`, `response`, `schema`, `document` or `other`. */
  where: string[];
  /** The JSON types of its values: `string`, `boolean`, `number`, `list`, `object`. */
  shapes: string[];
  /** One value, as JSON, cut short. Spec text: show it as text only. */
  sample: string;
  /** A role its name and values suggest. Only a suggestion: it has no effect until it is in the settings. */
  suggestedRole?: ExtensionRole;
  /** The role the settings of this build give it. */
  role?: ExtensionRole;
  /** False when it has a role that puts it on pages but sits where pages cannot show it. */
  shown?: boolean;
}

const shapeOf = (v: Json) => (Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v);

/** A role an extension's name and values suggest. Never applied on its own. */
export function suggestRole(name: string, where: string[], shapes: string[]): ExtensionRole | undefined {
  if (!where.includes('operation')) return undefined;
  const textual = shapes.every((s) => s === 'string' || s === 'list' || s === 'boolean' || s === 'number');
  if (!textual) return undefined;
  if (/error|problem|fault|failure/i.test(name)) return 'errors';
  if (/permission|scope|role|privilege|check|acl|auth/i.test(name)) return 'permission';
  if (/feature|require|need|depend|plan|tier|beta|preview/i.test(name)) return 'requires';
  return undefined;
}

/** Every vendor extension in the document, most used first. */
export function inventoryExtensions(model: SpecModel, settings: Settings = {}): ExtensionInfo[] {
  const found = new Map<string, { count: number; where: Set<string>; shapes: Set<string>; sample: string }>();
  const note = (name: string, value: Json, where: string) => {
    const e = found.get(name) ?? { count: 0, where: new Set<string>(), shapes: new Set<string>(), sample: '' };
    e.count++;
    e.where.add(where);
    e.shapes.add(shapeOf(value));
    if (!e.sample) e.sample = (JSON.stringify(value) ?? '').slice(0, 160);
    found.set(name, e);
  };
  const seen = new Set<Json>();
  const walk = (node: Json, where: string) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((x) => walk(x, where));
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('x-')) note(k, v, where);
      else walk(v, where);
    }
  };
  const doc = model.doc;
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('x-')) note(k, v, 'document');
    else if (k !== 'paths' && k !== 'components') walk(v, 'document');
  }
  for (const item of Object.values<Json>(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries<Json>(item)) {
      if (k.startsWith('x-')) note(k, v, 'other');
      else if (k === 'parameters') walk(v, 'parameter');
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries<Json>(v)) {
          if (k2.startsWith('x-')) note(k2, v2, 'operation');
          else walk(v2, k2 === 'parameters' ? 'parameter' : k2 === 'requestBody' ? 'request' : k2 === 'responses' ? 'response' : 'other');
        }
      }
    }
  }
  for (const [k, v] of Object.entries<Json>(doc.components ?? {})) walk(v, k === 'schemas' ? 'schema' : k === 'parameters' ? 'parameter' : k === 'responses' ? 'response' : k === 'requestBodies' ? 'request' : 'other');

  const out: ExtensionInfo[] = [];
  for (const [name, e] of found) {
    const where = [...e.where].sort();
    const shapes = [...e.shapes].sort();
    const role = settings.extensions?.[name]?.role;
    const suggestedRole = suggestRole(name, where, shapes);
    out.push({
      name,
      count: e.count,
      where,
      shapes,
      sample: e.sample,
      ...(suggestedRole ? { suggestedRole } : {}),
      ...(role ? { role } : {}),
      ...(role && role !== 'ignore' ? { shown: where.includes('operation') } : {}),
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/** Problems in the settings, as messages. Empty when they are usable. */
export function checkSettings(settings: Json): string[] {
  const problems: string[] = [];
  if (settings === undefined) return problems;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return ['Settings must be a JSON object.'];
  for (const k of Object.keys(settings)) if (k !== 'extensions') problems.push(`Unknown setting '${k}'.`);
  const ext = settings.extensions;
  if (ext === undefined) return problems;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return [...problems, "'extensions' must be an object keyed by extension name."];
  for (const [name, s] of Object.entries<Json>(ext)) {
    if (!name.startsWith('x-')) problems.push(`'${name}' is not an extension name: it does not start with x-.`);
    if (!s || typeof s !== 'object' || !EXTENSION_ROLES.includes(s.role)) problems.push(`'${name}' needs a role: one of ${EXTENSION_ROLES.join(', ')}.`);
    else if (s.label !== undefined && (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 80)) problems.push(`The label of '${name}' must be 1 to 80 characters of text.`);
    for (const k of Object.keys(s ?? {})) if (k !== 'role' && k !== 'label') problems.push(`Unknown key '${k}' in the setting for '${name}'.`);
  }
  return problems;
}

/** The extension fields written on an operation itself, in document order. */
export function operationExtensions(model: SpecModel, op: Operation): [string, Json][] {
  const raw = model.doc.paths?.[op.path]?.[op.method];
  return raw && typeof raw === 'object' ? Object.entries<Json>(raw).filter(([k]) => k.startsWith('x-')) : [];
}

/** The words shown before a value when the settings give no label. */
export function defaultLabel(name: string, role: ExtensionRole): string {
  if (role === 'permission') return 'Permission needed';
  if (role === 'requires') return 'Requires';
  const words = name.slice(2).replace(/[-_.]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** An extension's value as a list of plain strings, or undefined when it cannot be shown as text. */
export function textValues(value: Json): string[] | undefined {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'boolean') return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.map(String).filter((v) => v.trim());
  return undefined;
}
