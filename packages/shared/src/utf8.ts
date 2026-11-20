// UTF-8 length of a string, without TextEncoder (this package targets plain ES2023). Its own
// module with no imports, so the anchor schema (schemas.ts) and the data helpers (data.ts) share
// one copy without importing each other.

/** UTF-8 bytes of a string. A lone surrogate counts 3 bytes, as its replacement character does. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}
