// Files people add to a page: sniffing proves a type from the first bytes only, names are cleaned
// for display and headers, parts have exact sizes, and the declaration token stores only when set.
import { describe, expect, it } from "vitest";
import {
  type Capabilities,
  contentDisposition,
  createFileInput,
  FILE_LIMITS,
  FILE_TYPE_LIST,
  isFileType,
  maxPartBodyBytes,
  parseCapabilities,
  partCount,
  partLength,
  readStoredCapabilities,
  sanitizeFileName,
  serializeCapabilities,
  sniffFileType,
} from "../src/index.ts";

const bytes = (head: number[] | string, n = 64) => {
  const h = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  const out = new Uint8Array(Math.max(n, h.length));
  out.set(h);
  return out;
};
const ftyp = (brand: string) =>
  bytes([0, 0, 0, 0x18, ...[..."ftyp", ...brand].map((c) => c.charCodeAt(0))]);
const ebml = (docType: string) =>
  bytes([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x9f,
    0x42,
    0x86,
    0x81,
    0x01,
    0x42,
    0x82,
    0x84,
    ...[...docType].map((c) => c.charCodeAt(0)),
  ]);

describe("sniffFileType", () => {
  it("proves every accepted type from its signature", () => {
    const cases: [Uint8Array, string][] = [
      [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
      [bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
      [bytes("GIF89a"), "image/gif"],
      [bytes("GIF87a"), "image/gif"],
      [bytes("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
      [bytes("RIFF\0\0\0\0WAVEfmt "), "audio/wav"],
      [ftyp("avif"), "image/avif"],
      [ftyp("avis"), "image/avif"],
      [ftyp("isom"), "video/mp4"],
      [ftyp("mp42"), "video/mp4"],
      [ftyp("M4V "), "video/mp4"],
      [ftyp("M4A "), "audio/mp4"],
      [ebml("webm"), "video/webm"],
      [bytes("OggS\0\x02"), "audio/ogg"],
      [bytes("ID3\x04\0"), "audio/mpeg"],
      [bytes([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
      [bytes("%PDF-1.7\n"), "application/pdf"],
    ];
    for (const [b, type] of cases) expect(sniffFileType(b), type).toBe(type);
    expect(new Set(cases.map(([, t]) => t))).toEqual(new Set(FILE_TYPE_LIST));
  });

  it("refuses markup, refused brands, AAC frames and anything without a signature", () => {
    for (const b of [
      bytes('<svg xmlns="http://www.w3.org/2000/svg">'),
      bytes("<!doctype html><script>"),
      bytes("<?xml version='1.0'?>"),
      bytes("  %PDF-1.7"),
      ftyp("qt  "),
      ftyp("heic"),
      ftyp("mif1"),
      ftyp("crx "),
      ftyp("3gp5"),
      ebml("matroska"),
      bytes("RIFF\0\0\0\0AVI "),
      bytes([0xff, 0xf1, 0x50, 0x80]),
      bytes([]),
      bytes([0x89, 0x50]),
    ]) {
      expect(sniffFileType(b)).toBeNull();
    }
  });

  it("looks only at the start: a PDF with HTML after its header is a PDF, HTML with a PNG later is nothing", () => {
    const pdfThenHtml = new Uint8Array([
      ...bytes("%PDF-1.4\n", 9),
      ...bytes("<html><script>alert(1)</script>"),
    ]);
    expect(sniffFileType(pdfThenHtml)).toBe("application/pdf");
    const htmlThenPng = new Uint8Array([
      ...bytes("<html>", 6),
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);
    expect(sniffFileType(htmlThenPng)).toBeNull();
  });
});

describe("sanitizeFileName", () => {
  it("keeps the basename, drops control and bidi characters and appends the proven extension", () => {
    expect(sanitizeFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(sanitizeFileName("C:\\Users\\me\\shot.png", "image/png")).toBe("shot.png");
    expect(sanitizeFileName("evil.html", "image/png")).toBe("evil.html.png");
    expect(sanitizeFileName("photo\u202Egnp.exe", "image/jpeg")).toBe("photognp.exe.jpg");
    expect(sanitizeFileName("a\r\nSet-Cookie: x.png", "image/png")).toBe("aSet-Cookie: x.png");
    expect(sanitizeFileName("holiday.JPEG", "image/jpeg")).toBe("holiday.JPEG");
    expect(sanitizeFileName("...", "application/pdf")).toBe("file.pdf");
    expect(sanitizeFileName("", "audio/ogg")).toBe("file.ogg");
    expect(sanitizeFileName("cafe\u0301.png", "image/png")).toBe("café.png");
  });

  it("caps the name at the limit, keeping the extension", () => {
    const long = sanitizeFileName(`${"x".repeat(500)}.png`, "image/png");
    expect([...long].length).toBe(FILE_LIMITS.maxNameLength);
    expect(long.endsWith(".png")).toBe(true);
    const noExt = sanitizeFileName("y".repeat(500), "video/mp4");
    expect([...noExt].length).toBe(FILE_LIMITS.maxNameLength);
    expect(noExt.endsWith(".mp4")).toBe(true);
  });
});

describe("contentDisposition", () => {
  it("sends an ASCII fallback and the full name encoded", () => {
    expect(contentDisposition("inline", "a.png")).toBe(
      `inline; filename="a.png"; filename*=UTF-8''a.png`,
    );
    expect(contentDisposition("attachment", 'résumé "final"; v2.pdf')).toBe(
      `attachment; filename="r_sum_ _final__ v2.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%3B%20v2.pdf`,
    );
    expect(contentDisposition("inline", "it's (1)*.png")).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A.png",
    );
  });
});

describe("parts", () => {
  it("splits at the R2 multipart size, every part but the last exactly that long", () => {
    const P = FILE_LIMITS.partBytes;
    expect(P).toBe(5 * 1024 * 1024);
    expect(partCount(1)).toBe(1);
    expect(partCount(P)).toBe(1);
    expect(partCount(P + 1)).toBe(2);
    expect(partCount(20 * 1024 * 1024)).toBe(4);
    expect(partLength(P + 1, 1)).toBe(P);
    expect(partLength(P + 1, 2)).toBe(1);
    expect(partLength(10, 1)).toBe(10);
    expect(partLength(10, 2)).toBe(0);
    expect(partLength(10, 0)).toBe(0);
    expect(maxPartBodyBytes()).toBe(4 * Math.ceil(P / 3) + 64);
  });

  it("validates create bodies strictly", () => {
    expect(createFileInput.safeParse({ name: "a", type: "image/png", size: 1 }).success).toBe(true);
    expect(createFileInput.safeParse({ name: "a", type: "image/png", size: 0 }).success).toBe(
      false,
    );
    expect(
      createFileInput.safeParse({ name: "a", type: "image/png", size: 1, owner: "x" }).success,
    ).toBe(false);
    expect(isFileType("image/png")).toBe(true);
    expect(isFileType("image/svg+xml")).toBe(false);
    expect(isFileType("toString")).toBe(false);
  });
});

describe("the files declaration", () => {
  it("declares on its own, with no store and no room, and is stored only when declared", () => {
    const c = parseCapabilities('<meta name="plinth-capabilities" content="files">');
    expect(c).toMatchObject({ data: false, room: false, files: true });
    const stored = serializeCapabilities(c as Capabilities);
    expect(stored).toBe('{"data":false,"viewer":false,"shared":[],"files":true}');
    expect(readStoredCapabilities(stored)).toEqual(c);
    // Every declaration without it is stored exactly as before.
    const data = parseCapabilities('<meta name="plinth-capabilities" content="data viewer">');
    expect(data?.files).toBe(false);
    expect(serializeCapabilities(data as Capabilities)).toBe(
      '{"data":true,"viewer":true,"shared":[]}',
    );
    expect(readStoredCapabilities('{"data":true,"viewer":true,"shared":[]}')?.files).toBe(false);
    expect(readStoredCapabilities('{"data":true,"viewer":false,"files":false}')?.files).toBe(false);
  });
});
