// Menu items for a design system (type design_system). "Copy for an agent" puts a line on the
// clipboard that tells an agent which design system to build with. Only the id and the URL go in,
// never the title: titles are text other people wrote, and the line is pasted into an agent's chat.
import { RobotIcon } from "@phosphor-icons/react";
import { showToast } from "../ui/index.ts";
import type { MenuItem } from "./stageItems.tsx";

/** The line "Copy for an agent" copies. */
export function agentLine(o: { id: string; slug: string; appOrigin: string }): string {
  const url = `${o.appOrigin}/a/${encodeURIComponent(o.slug)}`;
  return `Use the Plinth design system at ${url} (get_design_system with id ${o.id}).`;
}

function copy(text: string): void {
  // Show the line to copy by hand when the browser refuses the clipboard.
  const manual = () => window.prompt("Copy this line for your agent", text);
  try {
    const p = navigator.clipboard?.writeText(text);
    if (p) p.then(() => showToast({ title: "Copied", tone: "success" }), manual);
    else manual();
  } catch {
    manual();
  }
}

export const copyForAgent: MenuItem = (c) => [
  {
    label: "Copy for an agent",
    icon: RobotIcon,
    onSelect: () =>
      copy(
        agentLine({
          id: c.gate.artifact.id,
          slug: c.gate.artifact.slug,
          appOrigin: c.config?.app_origin ?? window.location.origin,
        }),
      ),
  },
];
