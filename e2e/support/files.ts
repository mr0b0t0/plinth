// A gallery page for the files e2e specs: people add images, PDFs and video with an
// <input type="file">, and the list shows them. Data attributes the specs read:
// body[data-ready], body[data-reason], body[data-can-upload], body[data-progress],
// body[data-count], #status[data-error] (the last PlinthError code, or "" after an upload).

export const GALLERY_TITLE = "Team photos";

export const GALLERY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="plinth-capabilities" content="files viewer">
<title>${GALLERY_TITLE}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 16px; background: Canvas; color: CanvasText; }
  ul { list-style: none; padding: 0; }
  img { max-width: 100%; height: auto; min-width: 16px; }
</style>
<script src="/__plinth/runtime.js"></script>
</head>
<body>
<main>
  <h1>Team photos</h1>
  <label>Add a file <input id="pick" type="file" accept="image/png,image/jpeg,video/mp4,application/pdf"></label>
  <p id="status" role="status"></p>
  <ul id="list"></ul>
</main>
<script>
const status = document.getElementById("status");
const list = document.getElementById("list");
const pick = document.getElementById("pick");
function render(items) {
  list.replaceChildren(...items.map((f) => {
    const li = document.createElement("li");
    li.dataset.id = f.id;
    li.dataset.type = f.type;
    if (f.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = f.url;
      img.alt = "";
      li.append(img);
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name + (f.uploadedBy ? " by " + f.uploadedBy.email : "");
    li.append(name);
    return li;
  }));
  document.body.dataset.count = String(items.length);
}
const files = window.plinth && window.plinth.files;
(files ? files.ready : Promise.resolve({ available: false, reason: "no_runtime", canUpload: false })).then((s) => {
  document.body.dataset.reason = String(s.reason);
  document.body.dataset.canUpload = String(s.canUpload);
  pick.disabled = !s.canUpload;
  if (!s.available) {
    status.textContent = "Photos are not available here.";
    document.body.dataset.ready = "1";
    return;
  }
  if (!s.canUpload) status.textContent = "Only people this page is shared with can add photos.";
  files.onSnapshot(render, (e) => { status.dataset.error = e.code; });
  pick.onchange = async () => {
    const f = pick.files[0];
    if (!f) return;
    status.dataset.error = "";
    status.textContent = "Uploading " + f.name;
    try {
      await files.upload(f, { onProgress: (sent, total) => { document.body.dataset.progress = sent + "/" + total; } });
      status.textContent = "Added " + f.name;
      render(await files.all());
    } catch (e) {
      status.dataset.error = e.code;
      status.textContent = "Could not add " + f.name + " (" + e.code + ").";
    }
    pick.value = "";
  };
  document.body.dataset.ready = "1";
});
</script>
</body>
</html>
`;

/** A 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** `size` bytes that start like an MP4 (an ftyp box, brand isom). */
export function mp4Bytes(size: number): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(b);
  return b;
}
