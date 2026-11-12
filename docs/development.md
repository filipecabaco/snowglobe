# Local development

Build the web runtime and assemble the site with the normal repository workflow, then run
`mise run serve` and open `http://localhost:8000/apphost/`. App Host uses the generated
`dist/apphost/runtimes.json` and transport scripts alongside the sources in `site/apphost/`.
It does not require the separate Builder application or its gateway.

# Remote development on Claudius (maintainer setup)

The current development checkout is served inside the Tailscale network at
[claudius.tailb03e.ts.net:18455](https://claudius.tailb03e.ts.net:18455/).
Connect your laptop to Tailscale, then open the home page to choose an app.

- [App Host](https://claudius.tailb03e.ts.net:18455/apphost/) builds an existing local folder.
- [Builder](https://claudius.tailb03e.ts.net:18455/builder/) creates apps.
- [Dashboard](https://claudius.tailb03e.ts.net:18455/dashboard/) manages native development machines.

The `snowglobe-local-dev.service` systemd unit starts automatically at boot. Tailscale Serve
terminates HTTPS on port **18455** and proxies to **127.0.0.1:18456**. The Builder gateway uses
**127.0.0.1:18457**. The application servers listen only on loopback; Tailscale Serve provides
tailnet access. HTTPS is required for browser folder selection and service workers.

The machine-local launcher, dispatcher, and server are in `.local-dev/` and are not part of
the published application. The server uses
`SNOWGLOBE_DEV_ORIGIN`, `SNOWGLOBE_DEV_PORT`, and `SNOWGLOBE_GATEWAY_PORT`, rather than Aspire's
address. Static files come from `site/`, with generated VM assets from `dist/`. Go changes rebuild
the local binary and restart its daemon. App Host and Builder remain open during edits so a build
does not lose its VM to an automatic page reload; reload these pages to load changed UI code.

```sh
systemctl status snowglobe-local-dev
systemctl restart snowglobe-local-dev
journalctl -u snowglobe-local-dev -n 50 --no-pager
tailscale serve status
```

After changing the embedded browser VM scripts, build the CLI and run
`snowglobe agent-pages dist` to regenerate the runtime catalogs and scripts. This also writes
the App Host transports to `dist/apphost/`. The normal `mise run assemble` does this for releases.

# App Host environments

`site/apphost/environments.mjs` maintains the supported setups: static HTML/CSS/JavaScript,
React + Vite, Svelte + Vite, Vue + Vite, other Vite frontends, Create React App, and a manual
npm frontend setup. Detection reads the root `package.json`. Users can override detection,
the npm script name, and the output folder. Next.js, SvelteKit/Nuxt server applications,
workspace installs, non-npm package managers, and private registries need dedicated setups.

App Host requests read permission for a local folder in desktop Chrome or Edge. Every build
rereads the folder. Generated directories, Git metadata, and conventional credential files
(including `.env` and `.npmrc`) are excluded. To host an already built app, select its output
folder directly. Source is limited to 2,000 files / 32 MiB, individual files to 8 MiB, and the
compressed transfer to 8 MiB. Dependency installation and package scripts run in the user's
browser VM; source is never uploaded to the remote dev server or written back to the folder.

The npm recipes use `npm ci` with a lockfile, otherwise `npm install`, with development
dependencies included. Install lifecycle scripts are disabled. Build scripts execute inside
the VM. npm downloads use App Host's browser-backed registry relay. Vite gets the preview
base path automatically; other tools receive `PUBLIC_URL`. Client routers must support
hosting under that base path. The preview uses Snowglobe's existing same-origin HTTP bridge;
share applications you trust with this browser profile. Static output needs `index.html`.

Installed dependencies are kept outside disposable source snapshots. When `package.json`, the
npm lockfiles, and the Node/platform setup are unchanged, builds link the existing dependency
directory and skip npm entirely. A completed install is kept even when compilation fails or is
cancelled. Changing or removing a lockfile invalidates that installation; interrupted installs
are never reused. Existing deployments from the first version can be adopted without another
install. A cancelled legacy build can also donate its packages when npm's log confirms that its
installation finished successfully. Local/file-linked dependency graphs still install per source snapshot because
their contents can change independently of the manifests. The cache lasts for this VM's lifetime;
closing or reloading the page currently discards it along with the VM.

The install relay buffers each download before exposing it to npm, checks package bytes against
the supplied lockfile's integrity hash, and retries reset or incomplete transfers. Without a
supported integrity hash it validates gzip archives before extraction. It uses one npm download
at a time, avoids upstream socket reuse, and disables the local relay's short idle-connection
timeout. Verified npm downloads remain in the VM's npm cache after an interrupted installation;
partial dependency directories are not treated as ready. New page instances allow a bounded
one-hour build job and distinguish installation timeouts from compilation failures. Updating the
guest helper takes effect on the next build without reloading an existing VM.

For Svelte apps, App Host replaces named `@lucide/svelte` icon imports in `.svelte` files
with the installed package's public per-icon imports in the temporary build copy. This avoids
compiling the whole icon library before tree shaking. The optimizer uses the Svelte parser and
the package's actual exports, preserving aliases, type imports, comments outside imports, and
subsequent line numbers. Namespace imports and unknown exports stay unchanged. Package layouts
or custom syntax it cannot parse fall back to the original imports. Local source is never edited.

The VM serves the published files on port 4180, with MIME types and SPA fallback for built apps.
The deployment pointer changes after a successful build and output validation. Failures leave
the previous deployment available. Keep the tab open: this initial version does not save the
VM or restore folder access after closing the page.

```sh
node --test internal/site/apphost.test.mjs
go test ./internal/site
# With the dev server and built web VM available (uses a fixture for the folder picker):
APPHOST_URL=http://127.0.0.1:18456/apphost/ node bench/apphost.mjs --npm
node bench/apphost-cache.mjs
node bench/apphost-download.mjs
node bench/apphost-svelte.mjs
```
