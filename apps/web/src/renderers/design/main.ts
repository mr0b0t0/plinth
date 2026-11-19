// The design renderer bundle (served as /__plinth/types/design/design.js on content origins). The
// web build turns this file into one self-contained IIFE with no exports and no globals;
// build/renderers.ts.
import "./design.css";
import { boot } from "./boot.ts";

boot(window);
