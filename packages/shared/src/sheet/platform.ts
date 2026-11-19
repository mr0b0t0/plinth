// The few platform APIs the sheet code uses, typed here: this package targets plain ES2023 (no DOM
// or Worker types), and every runtime that loads it (Workers, browsers, Node 22) has them.
interface PlatformUrl {
  protocol: string;
  hostname: string;
}

interface Platform {
  URL: new (s: string) => PlatformUrl;
  TextDecoder: new () => { decode(b: Uint8Array): string };
  atob(s: string): string;
}

export const platform = globalThis as unknown as Platform;
