// Vite (and Vitest) import a file as text with the ?raw suffix.
declare module "*?raw" {
  const text: string;
  export default text;
}
