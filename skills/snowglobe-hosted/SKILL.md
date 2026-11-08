---
name: snowglobe-hosted
description: Use when working on the hosted side of snowglobe: the snowglobe-hosted handoff server (accounts, machines, saves, leases, teams, pushing team images, `/run/<token>/` links). Covers what works today and what does not; building and running locally is snowglobe-build and snowglobe-run.
---

# Hosted (the handoff server)

`snowglobe-hosted` is a separate repo: an Elixir (Francis) server in front of Supabase (Auth, Postgres, Storage) so a machine started in one place can be resumed in another. You deploy it yourself; its README describes local and production setup.

## Works today

- Accounts and login sessions (Supabase Auth; tokens verified against the project's published signing keys).
- Machines: create from a base image, list, delete.
- Leases: one place runs a machine at a time; a login session takes the lease and renews it every 30 s (it lasts 90 s); another session is refused unless it takes over.
- Saves: begin on top of the current head, upload to Storage through signed URLs, commit once every object arrived; a save on an old head is refused.
- Teams: a personal team per account; owners add existing accounts by email.
- Team images: push a built site, run it from a link.

```sh
snowglobe build ./my-app --out dist/my-app     # standalone, not pooled with `snowglobe pool`
SNOWGLOBE_EMAIL=you@example.com SNOWGLOBE_PASSWORD=... \
  elixir scripts/push.exs dist/my-app --name my-app --team "Acme" --server http://127.0.0.1:4000
```

Run `push.exs` from the snowglobe-hosted checkout. It uploads only blobs the team lacks. Members then run the image at `/run/<token>/`: the token lasts 12 hours and each file request re-checks membership.

## Not yet

- Saving and resuming from snowglobe itself (the page's Save button, `snowglobe run --machine`, autosave): today the API takes any bytes a client uploads.
- Client-side end-to-end encryption.
- Forks on conflicting saves, retention, rate limits.
- Remote builds (pushing a Dockerfile) and the cloud sandbox.
- Serving runs from a CDN; invitations for people without an account.

Do not tell a user a hosted save or resume command exists in the CLI.

More: the snowglobe-hosted README (`/README.md` in that repo) for the API table and deployment.
