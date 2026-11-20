// The settings page's Board section, on a whiteboard only (docs/spec.md "Whiteboards"): the
// owner's way to change the background and who can change the board. An editor changes the same
// two from Settings in the board's ⋯ menu (BoardSettingsDialog). Each save is the next version,
// against the version the section read; `onVersion` keeps the page's version number current,
// after a save and after a refused save that read a newer version.
import type { FormEvent } from "react";
import { Button } from "../ui/index.ts";
import { BoardSettingsFields } from "../viewer/BoardSettingsFields.tsx";
import { useBoardSettings } from "../viewer/useBoardSettings.ts";
import { Section } from "./SettingsSections.tsx";

export function BoardSection({
  artifactId,
  onVersion,
}: {
  artifactId: string;
  onVersion: (version: number) => void;
}) {
  const form = useBoardSettings(artifactId, onVersion);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const version = await form.save();
    if (version !== null) onVersion(version);
  };

  return (
    <Section id="settings-board" title="Board">
      <form className="pl-acct-form" onSubmit={(e) => void submit(e)} noValidate>
        <BoardSettingsFields form={form} />
        {form.state.kind === "ready" && (
          <div className="pl-acct-save">
            <Button type="submit" variant="primary" disabled={!form.changed} loading={form.saving}>
              Save board
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}
