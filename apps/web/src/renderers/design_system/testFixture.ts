// A small design system for the renderer tests (the Worker and end-to-end tests use
// apps/worker/test/fixtures/design-systems/acme.json).
export const FIXTURE = {
  format: "plinth.design-system/1",
  name: "Acme UI",
  description: "Product UI for **Acme**.",
  prefix: "acme",
  fonts: [
    {
      family: "Inter",
      google: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap",
    },
    { family: "Acme Mono", src: "fonts/acme-mono.woff2", weight: "400", style: "normal" },
  ],
  tokens: {
    color: {
      $type: "color",
      brand: { "500": { $value: "#3355ff", $description: "Primary actions" } },
      bg: { $value: "#ffffff" },
      fg: { $value: "#1f2328" },
      accent: { $value: "{color.brand.500}" },
      old: { $value: "#999999", $deprecated: "Use fg" },
    },
    space: { $type: "dimension", "2": { $value: "8px" } },
    radius: { $type: "dimension", md: { $value: "8px" } },
    font: {
      body: {
        $type: "typography",
        $value: { fontFamily: "Inter, sans-serif", fontSize: "16px", lineHeight: 1.5 },
      },
    },
    shadow: {
      card: {
        $type: "shadow",
        $value: { color: "#0000001f", offsetX: "0px", offsetY: "1px", blur: "3px" },
      },
    },
    motion: { fast: { $type: "duration", $value: "120ms" } },
    opacity: { $type: "number", $value: 0.5 },
  },
  themes: { dark: { color: { bg: { $value: "#0d1117" }, fg: { $value: "#e6edf3" } } } },
  guidelines: "# Using Acme UI\n\nOne primary button per view.",
  css: ".acme-btn { font: inherit; }",
  components: [
    {
      id: "button",
      name: "Button",
      description: "Triggers an action.",
      usage: "- Do: one per view",
      css: ".acme-btn--primary { background: var(--acme-color-accent); color: #fff; }",
      examples: [
        {
          name: "Primary",
          html: '<button class="acme-btn acme-btn--primary">Save</button>',
          height: 96,
        },
      ],
    },
    {
      id: "badge",
      name: "Badge",
      status: "beta",
      examples: [{ name: "Plain", html: "<span>New</span>" }],
    },
  ],
};
