// Vite's ?raw import (a file's text as a string, inlined at build time).
// Used by engine/bundledScripts.ts for the scripts that ship with the app.
declare module '*?raw' {
  const text: string;
  export default text;
}
