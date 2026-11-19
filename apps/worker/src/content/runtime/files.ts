// The runtime's files fragment (docs/spec.md "Files people add to a page"): plinth.files, for a
// page that declares `files`. It talks only to its own origin: /__plinth/api/v1/files... with the
// x-plinth-data header and JSON bodies (bytes as base64 inside {"data":"..."} parts, one part at a
// time), and /__plinth/files/<id> for the bytes. Nothing is fetched until the page first reads
// files.ready or calls a method. Under opaque isolation ready resolves unavailable without any
// request. It uses the core's PlinthError, toError, fireExpired, opaque and enc.
import type { RuntimeFragment } from "./fragment.ts";

export const FILES_FRAGMENT: RuntimeFragment = {
  name: "files",
  source: () => `  // ---------- files people add to the page ----------

  var FILES_API = API + "/files";

  async function fcall(method, path, body) {
    if (opaque) throw new PlinthError("unavailable", "Files are not available on this server.");
    var res;
    try {
      res = await fetch(FILES_API + path, {
        method: method,
        credentials: "same-origin",
        cache: "no-store",
        headers: { "x-plinth-data": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PlinthError("network", "Could not reach the server.");
    }
    var json = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch (e) {}
    }
    if (!res.ok) {
      var d = (json && json.error && json.error.details) || {};
      var msg = json && json.error && json.error.message;
      if (res.status === 400 && (d.reason === "unsupported_type" || d.reason === "type_mismatch")) {
        throw new PlinthError(d.reason, msg);
      }
      if (res.status === 404 && d.reason) throw new PlinthError("unavailable", msg);
      throw toError(res.status, json, res.headers);
    }
    return json;
  }

  function toFile(f) {
    var out = {
      id: f.id,
      name: f.name,
      type: f.type,
      size: f.size,
      url: f.url,
      mine: !!f.mine,
      createdAt: f.created_at,
    };
    if (f.uploaded_by) {
      out.uploadedBy = { email: f.uploaded_by.email, role: f.uploaded_by.role, via: f.uploaded_by.via };
    }
    return out;
  }

  var filesState = null;
  var filesLoading = null;
  var filesSeq = null;

  function filesOff(reason) {
    return {
      available: false,
      reason: reason,
      canUpload: false,
      accept: [],
      limits: null,
      usage: null,
    };
  }

  async function loadFiles() {
    if (opaque) return filesOff("opaque_isolation");
    try {
      var s = await fcall("GET", "/session");
      if (!s.available) return filesOff(s.reason);
      filesSeq = s.seq;
      return {
        available: true,
        reason: null,
        canUpload: !!s.can_upload,
        accept: s.accept || [],
        limits: {
          maxFileBytes: s.limits.max_file_bytes,
          maxFiles: s.limits.max_files,
          maxBytes: s.limits.max_bytes,
          maxBytesPerUploader: s.limits.max_bytes_per_uploader,
          partBytes: s.limits.part_bytes,
        },
        usage: { files: s.usage.files, bytes: s.usage.bytes, mineBytes: s.usage.mine_bytes },
      };
    } catch (e) {
      return filesOff(e && e.code === "expired" ? "expired" : "network");
    }
  }

  function filesReady() {
    if (!filesLoading) {
      filesLoading = loadFiles().then(function (s) {
        filesState = s;
        return s;
      });
    }
    return filesLoading;
  }

  async function filesUsable() {
    var s = await filesReady();
    if (!s.available) {
      if (s.reason === "expired") throw new PlinthError("expired", "Your access changed. Reload the page.");
      throw new PlinthError("unavailable", "Files are not available (" + s.reason + ").");
    }
    return s;
  }

  /** Base64 of bytes, in chunks so a 5 MiB part never needs one huge argument list. */
  function toBase64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fileUrl(id, opts) {
    return "/__plinth/files/" + enc(id) + (opts && opts.download ? "?download=1" : "");
  }

  // One shared poller of /files/changes, like the data poller.
  var fsubs = new Set();
  var ftimer = null;
  var fticking = false;

  function fschedule(ms) {
    if (ftimer) clearTimeout(ftimer);
    ftimer = null;
    if (!fsubs.size || document.visibilityState !== "visible") return;
    var every = POLL_MS;
    fsubs.forEach(function (s) {
      if (s.intervalMs < every) every = s.intervalMs;
    });
    ftimer = setTimeout(ftick, ms === undefined ? Math.max(MIN_POLL_MS, every) : ms);
  }
  function ffail(sub, err) {
    if (sub.done) return;
    sub.done = true;
    fsubs.delete(sub);
    if (sub.onError) {
      try {
        sub.onError(err);
      } catch (e) {}
    }
  }
  async function frefresh(sub) {
    var list = await files.all({ mine: sub.mine });
    if (!sub.done) sub.onFiles(list);
  }
  async function ftick(force) {
    ftimer = null;
    if (!fsubs.size || fticking) return;
    fticking = true;
    try {
      var r = await fcall("GET", "/changes");
      if (force === true || r.seq !== filesSeq) {
        var all = Array.from(fsubs);
        for (var i = 0; i < all.length; i++) await frefresh(all[i]);
        filesSeq = r.seq;
      }
    } catch (e) {
      if (e && (e.code === "expired" || e.code === "unavailable")) {
        Array.from(fsubs).forEach(function (s) {
          ffail(s, e);
        });
      }
    } finally {
      fticking = false;
      fschedule();
    }
  }
  function fkick() {
    if (!fsubs.size) return;
    if (ftimer) clearTimeout(ftimer);
    ftimer = setTimeout(function () {
      ftick(true);
    }, 0);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") fschedule(0);
    else fschedule();
  });

  var files = {
    url: fileUrl,
    list: async function (opts) {
      await filesUsable();
      opts = opts || {};
      var q = [];
      if (opts.limit) q.push("limit=" + encodeURIComponent(opts.limit));
      if (opts.cursor) q.push("cursor=" + encodeURIComponent(opts.cursor));
      if (opts.mine) q.push("mine=1");
      var r = await fcall("GET", q.length ? "?" + q.join("&") : "");
      return { files: r.files.map(toFile), nextCursor: r.next_cursor };
    },
    all: async function (opts) {
      var s = await filesUsable();
      var out = [];
      var cursor = null;
      var max = (s.limits && s.limits.maxFiles) || 500;
      do {
        var page = await files.list({ limit: 100, cursor: cursor, mine: opts && opts.mine });
        out = out.concat(page.files);
        cursor = page.nextCursor;
      } while (cursor && out.length < max);
      return out;
    },
    get: async function (id) {
      await filesUsable();
      try {
        return toFile(await fcall("GET", "/" + enc(id)));
      } catch (e) {
        if (e.code === "not_found") return null;
        throw e;
      }
    },
    delete: async function (id) {
      await filesUsable();
      await fcall("DELETE", "/" + enc(id));
      fkick();
    },
    upload: async function (blob, opts) {
      opts = opts || {};
      var s = await filesUsable();
      if (!s.canUpload) {
        throw new PlinthError("read_only", "Only people this page is shared with can add files.");
      }
      if (!blob || typeof blob.size !== "number" || typeof blob.slice !== "function") {
        throw new PlinthError("invalid", "upload needs a File or a Blob");
      }
      var type = String(blob.type || "").toLowerCase();
      if (s.accept.indexOf(type) < 0) {
        throw new PlinthError("unsupported_type", "Files of this type cannot be added here.");
      }
      if (blob.size < 1) throw new PlinthError("invalid", "The file is empty.");
      if (blob.size > s.limits.maxFileBytes) {
        throw new PlinthError("too_large", "The file is too large.");
      }
      var signal = opts.signal;
      if (signal && signal.aborted) throw new PlinthError("aborted", "The upload was cancelled.");
      var name = String(opts.name || blob.name || "file").slice(0, 400);
      var created = await fcall("POST", "", { name: name, type: type, size: blob.size });
      var id = created.file.id;
      var partBytes = created.part_bytes;
      var last = null;
      try {
        for (var n = 1; n <= created.parts; n++) {
          if (signal && signal.aborted) throw new PlinthError("aborted", "The upload was cancelled.");
          var from = (n - 1) * partBytes;
          var to = Math.min(blob.size, n * partBytes);
          var data = toBase64(new Uint8Array(await blob.slice(from, to).arrayBuffer()));
          for (var attempt = 0; ; attempt++) {
            try {
              last = await fcall("PUT", "/" + id + "/parts/" + n, { data: data });
              break;
            } catch (e) {
              if (e.code !== "network" || attempt >= RETRIES) throw e;
            }
          }
          data = null;
          if (typeof opts.onProgress === "function") {
            try {
              opts.onProgress(to, blob.size);
            } catch (e) {}
          }
        }
      } catch (e) {
        if (e && e.code !== "type_mismatch") fcall("DELETE", "/" + id).catch(function () {});
        throw e;
      }
      fkick();
      return toFile(last.file);
    },
    download: async function (id) {
      var f = await files.get(id);
      if (!f) throw new PlinthError("not_found", "File not found");
      var res;
      try {
        res = await fetch(fileUrl(id, { download: true }), { credentials: "same-origin" });
      } catch (e) {
        throw new PlinthError("network", "Could not reach the server.");
      }
      if (!res.ok) throw toError(res.status, null, res.headers);
      var href = URL.createObjectURL(await res.blob());
      var a = document.createElement("a");
      a.href = href;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(href);
      }, 10000);
    },
    onSnapshot: function (onFiles, onError, opts) {
      if (typeof onFiles !== "function") throw new PlinthError("invalid", "onSnapshot needs a callback");
      var ms = Number((opts && opts.intervalMs) || POLL_MS);
      var sub = {
        onFiles: onFiles,
        onError: onError,
        mine: !!(opts && opts.mine),
        intervalMs: Math.max(MIN_POLL_MS, ms),
        done: false,
      };
      (async function () {
        try {
          await filesUsable();
          await frefresh(sub);
        } catch (e) {
          ffail(sub, e);
          return;
        }
        if (sub.done) return;
        fsubs.add(sub);
        fschedule();
      })();
      return function stop() {
        sub.done = true;
        fsubs.delete(sub);
        fschedule();
      };
    },
  };
  Object.defineProperty(files, "ready", { get: filesReady, enumerable: true });
  plinth.files = Object.freeze(files);

`,
};
