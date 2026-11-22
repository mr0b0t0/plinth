// The design system renderer bundle (served as /__plinth/types/design_system/ds.js on content
// origins). The web build turns this file into one self-contained IIFE with no exports and no
// globals; build/renderers.ts. The doc page's styles come first: the guidelines, descriptions and
// usage are edited with the doc's own block editor (its on-page editing styles are in doc.css), and
// the site's own styles follow, so they win where both set something.
import "../doc/doc.css";
import "./ds.css";
import "../common/richblock.css";
import "../common/review.css";
import { boot } from "./boot.ts";

boot(window);
