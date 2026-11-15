// The part of @cloudflare/puppeteer that services/thumbnails.ts uses. TypeScript reads this file
// instead of the package's own declarations (tsconfig "paths"), because those reference Node's
// global types, which would change setTimeout and friends for the whole Worker. Wrangler still
// bundles the real package.
declare module "@cloudflare/puppeteer-types" {
  export interface Page {
    setViewport(v: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
    emulateMediaFeatures(features: { name: string; value: string }[]): Promise<void>;
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    screenshot(opts?: { type?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Uint8Array>;
  }
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  const puppeteer: { launch(binding: Fetcher): Promise<Browser> };
  export default puppeteer;
}
