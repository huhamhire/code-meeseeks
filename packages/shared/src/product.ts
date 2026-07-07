/**
 * Product-level constants shared across processes (brand-neutral codename `meebox`, public brand `Code Meeseeks`).
 * Keep external-facing URLs here so both the renderer (settings About page, code-suggestion template `<HOME>`
 * placeholder) and any future main-side use resolve the same single source of truth.
 */

/** The public project website (GitHub Pages). Single source of truth for the `<HOME>` template placeholder and the About page link. */
export const PRODUCT_HOME_URL = 'https://huhamhire.github.io/code-meeseeks/';

/**
 * Default code-suggestion draft layout used when the user leaves `agent.strategy.code_suggestion_layout` empty.
 * Single source of truth for both the deterministic fallback (renderCodeSuggestionDraft) and the settings editor's
 * placeholder, so "placeholder == actual default". Placeholders: `<TITLE>` / `<HOME>` / `<MODEL>` / `<SUGGESTIONS>`.
 */
export const DEFAULT_CODE_SUGGESTION_LAYOUT = '[[<TITLE>](<HOME>) (<MODEL>)]\n<SUGGESTIONS>';
