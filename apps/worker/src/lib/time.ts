export const nowIso = (): string => new Date().toISOString();
export const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
export const isPast = (iso: string | null | undefined): boolean =>
  !!iso && iso <= new Date().toISOString();
