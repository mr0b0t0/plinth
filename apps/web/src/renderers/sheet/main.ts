// The sheet renderer bundle (served as /__plinth/types/sheet/sheet.js on content origins). The web
// build turns this file into one self-contained IIFE with no exports and no globals, fflate
// inlined; build/renderers.ts.
import "./sheet.css";
import { boot } from "./boot.ts";

boot(window);
