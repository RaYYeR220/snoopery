/** Name of a part's body and joint in exported scenes and task specs: `<objectId>__<part>`. */
export const jointId = (objectId: string, part: string): string => `${objectId}__${part}`;

/** File-name-safe stem (letters, digits, `_`, `-`, `.`). */
export const fileStem = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_') || '_';

/** Valid USD prim name: `[A-Za-z_][A-Za-z0-9_]*`. */
export function usdName(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(t) ? t : `_${t}`;
}

/** Hands out unique names, suffixing `_2`, `_3`, … when a name is taken. */
export class NameSet {
  private readonly used = new Set<string>();

  constructor(reserved: Iterable<string> = []) {
    for (const name of reserved) this.used.add(name);
  }

  take(base: string): string {
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}_${i}`;
    this.used.add(name);
    return name;
  }
}

export function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** USD string literal. */
export const usdString = (s: string): string => JSON.stringify(s);
