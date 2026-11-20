// The two board settings as compact choices (docs/spec.md "Whiteboards"): the background and who
// can change the board, each one row of short labels. Native radio buttons in a fieldset, so arrow
// keys move the choice and Tab enters and leaves a group as one stop. Shared by the board's
// Settings dialog and the Board section of the settings page; useBoardSettings holds the state.
import { BOARD_SETTING_LABELS, type BoardBackground, type BoardEditMode } from "@plinth/shared";
import { Button, SegmentedControl, Spinner } from "../ui/index.ts";
import { BACKGROUND_CHOICES, EDIT_CHOICES } from "./boardSettings.ts";
import type { BoardSettingsForm } from "./useBoardSettings.ts";
import "./boardSettings.css";

export function BoardSettingsFields({ form }: { form: BoardSettingsForm }) {
  const { state, chosen, notice, error, set, retry } = form;
  if (state.kind === "loading") return <Spinner label="Loading the board settings" />;
  if (state.kind === "error") {
    return (
      <div className="pl-board-settings__error" role="alert">
        <p>{state.message}</p>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!chosen) return null;
  return (
    <div className="pl-board-settings">
      {notice && (
        <p className="pl-board-settings__notice" role="status">
          {notice}
        </p>
      )}
      <SegmentedControl<BoardBackground>
        label={BOARD_SETTING_LABELS.background}
        showLabel
        options={[...BACKGROUND_CHOICES]}
        value={chosen.background}
        onChange={(background) => set({ background })}
        className="pl-board-settings__group"
      />
      <SegmentedControl<BoardEditMode>
        label={BOARD_SETTING_LABELS.edit}
        showLabel
        options={[...EDIT_CHOICES]}
        value={chosen.edit}
        onChange={(edit) => set({ edit })}
        className="pl-board-settings__group"
      />
      {error && (
        <p className="pl-board-settings__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
