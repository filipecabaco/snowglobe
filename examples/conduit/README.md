# Conduit + Supabase

The RealWorld blogging app in one Snowglobe ARM64 Linux VM: a React frontend,
Supabase Auth, PostgREST, and Postgres. Every application operation uses
`@supabase/supabase-js`. There is no separate application API or direct SQL
client in the frontend. SQL is used only to install the schema.

## Run

```sh
snowglobe build examples/conduit --out dist/conduit
snowglobe agent-pages dist
snowglobe serve dist
```

Open `/agent/?runtime=conduit`, then **Open the app** and **Allow** at the
studio’s one-time machine permission prompt. The studio opens port 4173
of the Conduit machine. `/conduit/` is its terminal demo. Both services run inside
the same guest; no Supabase cloud project, external API key, or Docker daemon is
needed inside it. The host uses Docker to build the image, as with the other examples.

For a native run, forward the single HTTP port:

```sh
snowglobe run dist/conduit -p 14173:4173
```

Then visit `http://localhost:14173/`. The server proxies `/supabase/*` to the
local Supabase gateway, preserving the user's JWT and public API key. A generated
`config.js` exposes only the anon key. Relative asset/API URLs and hash routing
also work under the studio's service-worker preview prefix.

The app starts empty: create an account and write the first article. It supports
registration/login/logout, profile settings, Markdown article CRUD, tags, paginated global
and following feeds, comments, favorites, and follows. Email confirmation is disabled by the
local stack. Each browser VM has its own data; use Snowglobe's save/resume controls
to preserve changes.

## Standalone client-only hosting

The frontend is a standalone SPA, with no Next.js, server-side rendering, or
application server. To host it independently of the VM:

```sh
cd examples/conduit/app
npm ci
npm run build
cp config.example.js dist/config.js
```

Edit `dist/config.js` with your Supabase project's URL and **public anon key**,
apply `supabase/migrations/20261107000000_conduit.sql` to that project, and host
`dist/` on any static web server. The browser then connects directly to Supabase;
`server.mjs` is not needed. Never put a service-role key in browser configuration.
Hash routing needs no server-side fallback rules. Configure Supabase Auth's site
URL and email-confirmation behavior for your host. The guest generates its own
config automatically and uses the same client build.

## Implementation research

- [RealWorld](https://github.com/realworld-apps/realworld) defines the Conduit app.
- [dpwls02142/next-realworld-example-app](https://github.com/dpwls02142/next-realworld-example-app)
  has actual `supabase-js` implementations of articles, profiles, comments and
  follows. It was inspected as a reference, but has no license file in the
  inspected checkout and depends on Next 9 / React 16. No source was copied.
- [vndevteam/realworld-nextjs-supabase](https://github.com/vndevteam/realworld-nextjs-supabase)
  documents a Next/Supabase implementation but the inspected checkout was a
  starter without application migrations or the Supabase dependency.
- [Next.js 14 + Supabase discussion](https://github.com/realworld-apps/realworld/discussions/1536)
  describes another implementation; its author's public repositories no longer
  expose the linked Conduit source.

This example is a new implementation of Conduit's feature set and familiar green
layout, built on this repo's native Supabase VM setup. It uses the Supabase data
API directly rather than implementing RealWorld's separate REST endpoint contract.

## Checks

```sh
cd examples/conduit/app
npm ci
npm run build
npm test
# With a disposable running guest on port 14173:
CONDUIT_URL=http://localhost:14173 npm run test:integration
```

For the browser flow check, install the existing `bench/` Playwright dependencies
and Chromium, then run `node examples/conduit/browser.test.mjs` from the repo root
against the disposable guest (the same `CONDUIT_URL` applies). It signs up a writer with one
article through the API first, for the UI user to follow.

The integration check creates two accounts and exercises article CRUD, comments,
favorites, follows, tags, joined feeds, and rejected anonymous/cross-user writes.
It removes its articles and relations; test accounts remain in the disposable VM.
The transport test checks request forwarding, error status preservation, public
configuration and path confinement. The migration enables RLS on every table.

Keep the native-stack preparation in `Dockerfile` aligned with
`../supabase/Dockerfile`. Frontend dependencies are pinned in `app/package-lock.json`.
