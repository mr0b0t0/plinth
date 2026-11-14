// Icon conventions: Phosphor, regular weight everywhere (a 1px stroke at 16px, the 1.5 / 24 of the
// design), 16px next to text, sizes from the 4px grid.
// Components take an icon as a component (`icon={TrashIcon}`) and size it themselves.
import { type Icon, IconContext } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export type { Icon };

/** Pixel sizes matching --icon-xs / --icon-sm / --icon-md / --icon-lg / --icon-xl. */
export const ICON_SIZE = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 } as const;
export type IconSize = keyof typeof ICON_SIZE;

export const ICON_WEIGHT = "regular" as const;

const defaults = { size: ICON_SIZE.sm, weight: ICON_WEIGHT, mirrored: false };

/** Sets the default icon size and weight for everything inside (the shells render it). */
export function IconProvider({ children }: { children: ReactNode }) {
  return <IconContext.Provider value={defaults}>{children}</IconContext.Provider>;
}
