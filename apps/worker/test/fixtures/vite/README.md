# Vite build fixtures (publish warnings)

Real output of `vite build` (the version apps/web pins) for a small app: a module entry that
imports a stylesheet, a helper and an image (`new URL("./logo.svg", import.meta.url)`), loads a
chunk with `import()`, and a stylesheet with an `@font-face` font and a background image. The
public folder holds `favicon.svg`. `build.assetsInlineLimit` is 0 so every asset is a file.

- `default/`: the default `base: "/"` (root-absolute URLs).
- `relative/`: `base: "./"` (relative URLs, what the skill tells agents to use).

Text files carry a `.txt` suffix so the linter leaves the minified output alone; `files.txt`
lists every file of the build (binary ones included) as the manifest would.
