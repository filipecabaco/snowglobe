// Preact 11.1.1, its hooks and htm 3.1.1, from npm (sha512 integrity checked), with hooks'
// import of "preact" made relative: the page has no build step and no import map (its CSP
// refuses inline scripts). `html` is htm bound to Preact's h.
import { h } from "./preact.mjs";
import htm from "./htm.mjs";

export * from "./preact.mjs";
export * from "./hooks.mjs";
export const html = htm.bind(h);
