import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemePreference, setThemePreference, THEME_STORAGE_KEY } from "../../lib/theme.ts";
import { ThemeSwitch, ThemeToggle } from "./ThemeToggle.tsx";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.setAttribute("data-theme", "light");
});
afterEach(cleanup);

describe("ThemeToggle", () => {
  it("switches to After hours, sets data-theme and persists the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: /Switch to After hours/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: /Switch to Gallery/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("uses the key and values public/theme.js reads before first paint", () => {
    expect(THEME_STORAGE_KEY).toBe("plinth-theme");
  });
});

describe("ThemeSwitch", () => {
  it("offers Gallery, After hours and System as one radio group", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    expect(screen.getByRole("group", { name: "Color mode" })).toBeTruthy();
    const system = screen.getByRole("radio", { name: "System" }) as HTMLInputElement;
    expect(system.checked).toBe(true);

    await user.click(screen.getByRole("radio", { name: "After hours" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(system);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(getThemePreference()).toBe("system");
  });

  it("going back to System follows the system setting", () => {
    setThemePreference("dark");
    setThemePreference("system");
    const sys = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    expect(document.documentElement.getAttribute("data-theme")).toBe(sys);
  });
});
