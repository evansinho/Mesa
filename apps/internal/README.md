# @mesa/internal — Mesa Sales Console

Internal commercial tooling for Mesa's own team. Not merchant-facing.

Built from the design handoff in `idea/Mesa interface design.zip`; the model and
rules behind it are in `idea/sales-lifecycle-spec.md`.

---

## What it is

A static SPA (React 19 + Vite + TanStack Router) that talks to `/staff/*` on the
existing Mesa API. There is no server of its own.

The one thing to understand before changing anything: **the sales team owns the
funnel only up to signup.** Everything after — connected, first order, first
payment, activated, paying, at risk, churned — is derived from the product
tables by a sweep in `apps/worker` and is not editable by anyone. The UI reflects
that: the kanban refuses drops on derived columns, and the lifecycle rail is
read-only.

## Local development

```bash
# 1. API against the test database
cd apps/api && DATABASE_URL=postgres://mesa:mesa@localhost:5433/mesa_test PORT=3002 pnpm dev

# 2. Seed a working set and derive lifecycle state (from the repo root)
DATABASE_URL=postgres://mesa:mesa@localhost:5433/mesa_test pnpm commercial:reset

# 3. This app
cd apps/internal && VITE_API_URL=http://localhost:3002 pnpm dev   # :3004
```

Seeded logins are printed by the seed. All three share one password; the roles
differ, and signing in as each is the quickest way to see the scoping work.

**Running the API integration suite truncates that database.** Re-run
`pnpm commercial:reset` afterwards.

## Deployment — Cloudflare Pages

Static build, so Pages serves it directly. Mirrors how the merchant dashboard is
hosted.

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `pnpm --filter @mesa/internal build` |
| Build output directory | `apps/internal/dist` |
| Root directory | *(repo root — the build needs the workspace)* |
| Node version | 20 |

Build-time environment variable:

| Name | Value |
|---|---|
| `VITE_API_URL` | the production API origin, e.g. `https://api.getmesa.co` |

`VITE_*` vars are inlined at build time, not read at runtime — changing one
needs a rebuild, not just a redeploy.

`public/_redirects` sends every unmatched path to `index.html`. Without it, deep
links like `/merchants` 404 and the app only works if you enter through `/`.

### The API has to allow the new origin

The API reflects any origin unless `CORS_ALLOWED_ORIGINS` is set. Once this is
live, set it on the API to pin things down — and include the merchant dashboard,
or you will take it offline:

```
CORS_ALLOWED_ORIGINS=https://app.getmesa.co,https://sales.getmesa.co
```

### Worth doing: put Cloudflare Access in front

This app reads every merchant's revenue, phone numbers and customer names. It
authenticates properly, but an Access policy in front means the login form is
not even reachable from the public internet. Cheap, and it is the kind of thing
that is much easier to add now than after an incident.

## First deploy checklist

1. **Run the migrations against production first.** `0045`, `0046` and `0047`
   create every table this app reads. Until they exist, `/staff/*` returns 500
   and the worker's sweep throws on each 15-minute tick.
   ```bash
   DATABASE_URL=<production> pnpm db:migrate
   ```
2. Deploy the API and worker (they carry the `/staff/*` routes and the sweep).
3. Create the first admin — nothing creates one for you, and staff accounts are
   deliberately not self-serve:
   ```bash
   pnpm --filter @mesa/api staff:create -- \
     --email you@getmesa.co --name "Your Name" --role admin
   ```
   It prints a temporary password once. You will be forced to change it on
   first sign-in.
4. Create the Pages project with the settings above.
5. Set `CORS_ALLOWED_ORIGINS` on the API.
6. Sign in and set the milestone target on the Team page. Until then it falls
   back to 50.

## Structure

```
src/
├── components/      AppShell, MerchantDrawer, charts, StageBadge
├── lib/             api, auth, dashboard + prospects hooks, merchants
├── pages/           Queue, Overview, Pipeline, Merchants, Team, prospect CRUD
├── styles/
│   ├── tokens/      copied verbatim from the design handoff — do not edit
│   └── app.css      composes the tokens; app-specific aliases live here
└── router.tsx
```

One convention worth keeping: **a query key owns a shape.** Two components
reading the same endpoint under one key must return the same thing from
`queryFn` — narrow with `select` or use a different key. Getting this wrong took
the Team page down with `rows.map is not a function`, because the shared cache
entry was populated by whichever query resolved first. `lib/dashboard.ts` and
`lib/prospects.ts` exist to make that hard to repeat, and `test/pages.test.tsx`
has regression coverage that mounts the conflicting pages together.
