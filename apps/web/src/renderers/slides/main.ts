// The slides renderer bundle (served as /__plinth/types/slides/slides.js on content origins). The
// web build turns this file into one self-contained IIFE with no exports and no globals;
// build/renderers.ts.
import "./slides.css";
import "../common/richblock.css";
import "../common/review.css";
import { boot } from "./boot.ts";

boot(window);
