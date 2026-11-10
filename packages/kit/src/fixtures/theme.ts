// The project's theme, set in each persona's browser before the app's first script runs. Its own module: Playwright
// sends the function to the browser as source text, so it must not close over anything, and a unit test can run it
// against a stand-in `window`.

/**
 * Store `value` under `theme`, the key most apps read, unless the browser already holds one. The init script runs on
 * every page load: a theme the test switches to in the app must survive the next reload.
 */
export function keepOrSetTheme(value: string): void {
  try {
    if (window.localStorage.getItem('theme') === null) window.localStorage.setItem('theme', value);
  } catch {
    // storage unavailable: the page follows prefers-color-scheme
  }
}
