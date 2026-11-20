// The whiteboard renderer bundle (served as /__plinth/types/whiteboard/whiteboard.js on content
// origins, after /__plinth/runtime.js). The web build turns this file into one self-contained IIFE
// with no exports and no globals; build/renderers.ts.
import "./whiteboard.css";
import { boot } from "./boot.ts";

boot(window);
