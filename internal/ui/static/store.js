// What the page knows, shared between app.js (the timeline and the tables, written by hand) and
// the Preact parts (the graph, the inspector, the tasks): app.js fills `state` from the daemon and
// calls publish(); a component reads it through useStore() and acts through `actions`.

import { useEffect, useState } from "./vendor/preact/index.js";

export const store = {
  // The daemon's lists, the graph, links, and what is selected (app.js's state object)
  state: null,
  // What app.js lends the components: api, act, select, openTerminal, refresh, banner
  actions: {},
};

const subs = new Set();
export function publish() {
  for (const f of subs) f();
}
export function subscribe(f) {
  subs.add(f);
  return () => subs.delete(f);
}

// The store, re-rendering the component whenever it is published
export function useStore() {
  const [, tick] = useState(0);
  useEffect(() => subscribe(() => tick((n) => n + 1)), []);
  return store;
}
