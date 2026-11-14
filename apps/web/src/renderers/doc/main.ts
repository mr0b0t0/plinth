// The doc renderer bundle (served as /__plinth/types/doc/doc.js on content origins). The web build
// turns this file into one self-contained IIFE with no exports and no globals; build/renderers.ts.
import "./doc.css";
import { boot } from "./boot.ts";

boot(window);
