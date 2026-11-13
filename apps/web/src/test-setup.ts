// Vitest setup for the web app. Async queries get a longer timeout so tests stay stable when the
// whole monorepo's suites run in parallel on a busy machine.
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 5000 });
