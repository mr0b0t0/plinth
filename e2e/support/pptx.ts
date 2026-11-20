// Reads a downloaded .pptx (a zip) for the deck export tests: its slides, notes and media.
import { readFile } from "node:fs/promises";
import type { Download } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

export interface PptxFile {
  name: string;
  files: string[];
  slides: string[];
  notes: string[];
  media: string[];
  text: (path: string) => string;
}

export async function readPptx(download: Download): Promise<PptxFile> {
  const path = await download.path();
  const zip = unzipSync(new Uint8Array(await readFile(path)));
  const files = Object.keys(zip).sort();
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const text = (p: string) => {
    const f = zip[p];
    if (!f) throw new Error(`no ${p} in the .pptx`);
    return strFromU8(f);
  };
  const slides = files
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => num(a) - num(b))
    .map(text);
  const notes = files
    .filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))
    .sort((a, b) => num(a) - num(b))
    .map(text);
  const media = files.filter((f) => f.startsWith("ppt/media/") && !f.endsWith("/"));
  return { name: download.suggestedFilename(), files, slides, notes, media, text };
}
