// The part of @cloudflare/puppeteer that services/thumbnails.ts and designExport.ts use. TypeScript
// reads this file instead of the package's own declarations (tsconfig "paths"), because those
// reference Node's global types, which would change setTimeout and friends for the whole Worker.
// Wrangler still bundles the real package.
declare module "@cloudflare/puppeteer-types" {
  export interface Page {
    setViewport(v: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
    emulateMediaFeatures(features: { name: string; value: string }[]): Promise<void>;
    goto(
      url: string,
      opts?: { waitUntil?: string; timeout?: number },
    ): Promise<{ ok(): boolean; status(): number; url(): string } | null>;
    screenshot(opts?: {
      type?: "png" | "jpeg" | "webp";
      quality?: number;
      /** services/designExport.ts: the board's box, and no white page under a transparent one. */
      clip?: { x: number; y: number; width: number; height: number };
      omitBackground?: boolean;
    }): Promise<Uint8Array>;
    /** services/designExport.ts: the browser's base64 as it came, so its size is checked first. */
    screenshot(opts: {
      type: "png";
      clip: { x: number; y: number; width: number; height: number };
      omitBackground: boolean;
      encoding: "base64";
    }): Promise<string>;
    createCDPSession(): Promise<CDPSession>;
    // services/designExport.ts
    /** "print" puts the design renderer in its export layout as the page boots. */
    emulateMediaType(type: "print" | "screen"): Promise<void>;
    /** Resolves once the expression (evaluated in the page) is truthy. */
    waitForFunction(expression: string, opts?: { timeout?: number }): Promise<unknown>;
    /** The expression's value in the page. */
    evaluate(expression: string): Promise<unknown>;
    $(selector: string): Promise<ElementHandle | null>;
  }
  export interface ElementHandle {
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  }
  /** A DevTools protocol session (only the calls services/thumbnails.ts and designExport.ts make). */
  export interface CDPSession {
    send(method: "Network.setCookie", params: object): Promise<unknown>;
    /** services/designExport.ts: print or screen media, through the session that holds the page. */
    send(
      method: "Emulation.setEmulatedMedia",
      params: { media: string; features?: { name: string; value: string }[] },
    ): Promise<unknown>;
    /** services/designExport.ts: the PDF as a stream the Worker reads in pieces. */
    send(
      method: "Page.printToPDF",
      params: { transferMode: "ReturnAsStream"; [option: string]: unknown },
    ): Promise<{ stream?: string }>;
    send(
      method: "IO.read",
      params: { handle: string; size: number },
    ): Promise<{ data: string; base64Encoded?: boolean; eof: boolean }>;
    send(method: "IO.close", params: { handle: string }): Promise<unknown>;
  }
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  const puppeteer: { launch(binding: Fetcher): Promise<Browser> };
  export default puppeteer;
}
