// The lazy .pptx writer bundle (served as /__plinth/types/slides/slides-pptx.js on content origins,
// built by build/renderers.ts from the registry's `lazy` list). The deck's renderer adds this
// script to its own page only when someone downloads the deck as .pptx (export.ts). It exports
// nothing and defines no global: it hands its writer to the renderer through one event on the
// document, which the renderer listens for before it inserts the script.
import { PPTX_READY_EVENT } from "./pptxModel.ts";
import { buildPptx } from "./pptxWriter.ts";

document.dispatchEvent(new CustomEvent(PPTX_READY_EVENT, { detail: { build: buildPptx } }));
