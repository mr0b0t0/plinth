// Version picker for the artifact top bar (workstream: history). Placeholder.
export interface VersionPickerProps {
  slug: string;
  current: number;
  /** The version being shown. */
  shown: number;
}
export function VersionPicker({ shown }: VersionPickerProps) {
  return <span>v{shown}</span>;
}
