// Builds each typed artifact's renderer (TYPE_REGISTRY rows with a renderer) into the web bundle at
// __plinth-renderers/<id>/<script> and <style>. The content host serves those files to artifact
// origins as /__plinth/types/<id>/... (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md).
//
// Each renderer is its own nested library build: one minified IIFE with every dependency inlined,
// so it never shares a chunk with the SPA and defines no globals. It runs inside the main build
// (not as a second `vite build`), because `vite build --watch` empties dist on every rebuild and
// would wipe a separately built bundle. Its source files join the watch list.
import {
  ARTIFACT_TYPES,
  type ArtifactTypeDef,
  RENDERERS_DIR,
  rendererFiles,
  TYPE_REGISTRY,
} from "@plinth/shared";
import { build, type Plugin, type ResolvedConfig } from "vite";

interface Built {
  fileName: string;
  source: string | Uint8Array;
}

async function buildRenderer(
  config: ResolvedConfig,
  def: ArtifactTypeDef & { renderer: { script: string; style: string } },
): Promise<{ assets: Built[]; watch: string[] }> {
  const { id, renderer: files } = def;
  const result = await build({
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: "warn",
    publicDir: false,
    envFile: false,
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      sourcemap: false,
      cssCodeSplit: false,
      reportCompressedSize: false,
      lib: {
        entry: `${config.root}/src/renderers/${id}/main.ts`,
        formats: ["iife"],
        // Required for an IIFE. The entry exports nothing, so no global is assigned.
        name: `plinthRenderer_${id}`,
        fileName: () => files.script,
        cssFileName: files.style.replace(/\.css$/, ""),
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const assets: Built[] = [];
  const watch = new Set<string>();
  for (const out of outputs) {
    if (!("output" in out)) throw new Error(`Renderer ${id}: unexpected build result`);
    for (const item of out.output) {
      if (item.type === "chunk") {
        assets.push({ fileName: item.fileName, source: item.code });
        for (const m of item.moduleIds) {
          if (!m.startsWith("\0") && !m.includes("/node_modules/")) watch.add(m.split("?")[0] ?? m);
        }
      } else {
        assets.push({ fileName: item.fileName, source: item.source });
      }
    }
  }
  // Exactly the files the content host serves for this type, no more.
  const wanted = rendererFiles(def).map((f) => f.name);
  for (const want of wanted) {
    if (!assets.some((a) => a.fileName === want)) {
      throw new Error(`Renderer ${id}: the build did not produce ${want}`);
    }
  }
  return {
    assets: assets.filter((a) => wanted.includes(a.fileName)),
    watch: [...watch],
  };
}

export function renderers(): Plugin {
  let config: ResolvedConfig;
  let built: { id: string; assets: Built[] }[] = [];
  return {
    name: "plinth-renderers",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      built = [];
      for (const id of ARTIFACT_TYPES) {
        const def: ArtifactTypeDef = TYPE_REGISTRY[id];
        if (!def.renderer) continue;
        const { assets, watch } = await buildRenderer(config, { ...def, renderer: def.renderer });
        for (const file of watch) this.addWatchFile(file);
        built.push({ id: def.id, assets });
      }
    },
    generateBundle() {
      for (const { id, assets } of built) {
        for (const a of assets) {
          this.emitFile({
            type: "asset",
            fileName: `${RENDERERS_DIR}/${id}/${a.fileName}`,
            source: a.source,
          });
        }
      }
    },
  };
}
