// Comments side panel for the artifact page (workstream: comments). Placeholder.
export interface CommentsPanelProps {
  artifactId: string;
  slug: string;
  version: number;
  /** The artifact iframe, for the review-mode bridge (anchoring). */
  frame: HTMLIFrameElement | null;
  /** Content origin of the artifact (postMessage target). */
  contentOrigin: string;
  onClose: () => void;
}
export function CommentsPanel(_props: CommentsPanelProps) {
  return null;
}
