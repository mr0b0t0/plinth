// A version's own files, for a page that shows a draft or an older version (inline editing): the
// draft is published with the files of its base version, so in edit mode and in the review every
// file reference resolves through fileUrl(version, path) to /__plinth/v/<version>/<path>, and the
// page never shows a file the draft (or that pane) would not publish. Same origin, through the
// content pass, which allows every version there.

const PROBE = "https://plinth.invalid/";

/** Version `version`'s copy of the artifact file at `path` (relative to the artifact root). */
export function fileUrl(version: number, path: string): string {
  const clean = path.replace(/^\.?\//, "");
  return `/__plinth/v/${version}/${clean}`;
}

/**
 * `src` pinned to version `version`, when it names one of the artifact's own files (a relative or
 * root-relative path); null for anything else (another host, data:, Plinth's own /__plinth/ paths).
 */
export function pinnedSrc(src: string, version: number): string | null {
  if (src === "" || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(src, PROBE);
  } catch {
    return null;
  }
  if (u.origin !== new URL(PROBE).origin || u.pathname.startsWith("/__plinth/")) return null;
  return `/__plinth/v/${version}${u.pathname}${u.search}${u.hash}`;
}

const ORIGINAL = "data-plinth-src";

/**
 * Point every image under `root` at version `version`'s copy of its file, keeping the address it
 * was written with so it can be pinned to another version later (or back, with null).
 */
export function pinFiles(root: ParentNode, version: number | null): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const original = img.getAttribute(ORIGINAL) ?? img.getAttribute("src");
    if (original === null) continue;
    const pinned = version === null ? null : pinnedSrc(original, version);
    if (pinned === null) {
      if (img.hasAttribute(ORIGINAL)) {
        img.setAttribute("src", original);
        img.removeAttribute(ORIGINAL);
      }
      continue;
    }
    img.setAttribute(ORIGINAL, original);
    if (img.getAttribute("src") !== pinned) img.setAttribute("src", pinned);
  }
}

/** Version `n`'s source file (`file`, the type's source path) from this origin, or null. */
export async function fetchVersionSource(
  win: Window,
  n: number,
  file: string,
): Promise<string | null> {
  if (!Number.isInteger(n) || n < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file)) return null;
  try {
    const res = await win.fetch(fileUrl(n, file), {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
