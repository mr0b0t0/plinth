// The design system renderer bundle (served as /__plinth/types/design_system/ds.js on content
// origins). The web build turns this file into one self-contained IIFE with no exports and no
// globals; build/renderers.ts.
import "./ds.css";
import { boot } from "./boot.ts";

boot(window);
