import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import {
  THEME_NAMES,
  type ThemePreference,
  useTheme,
  useThemePreference,
} from "../../lib/theme.ts";
import { IconButton } from "./Button.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** One button that flips between Gallery and After hours (and remembers the choice). */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${THEME_NAMES[next]} (${next} mode)`;
  return (
    <Tooltip content={label} placement="bottom">
      <IconButton
        icon={theme === "dark" ? SunIcon : MoonIcon}
        label={label}
        onClick={() => setTheme(next)}
      />
    </Tooltip>
  );
}

/** Gallery / After hours / System, for settings and the /design page. */
export function ThemeSwitch({ size = "md" }: { size?: "sm" | "md" }) {
  const [pref, setPref] = useThemePreference();
  return (
    <SegmentedControl<ThemePreference>
      label="Color mode"
      size={size}
      value={pref}
      onChange={setPref}
      options={[
        { value: "light", label: THEME_NAMES.light, icon: SunIcon },
        { value: "dark", label: THEME_NAMES.dark, icon: MoonIcon },
        { value: "system", label: "System", icon: DesktopIcon },
      ]}
    />
  );
}
