# Product Image Sync

Multi-tenant SaaS that uploads Google Drive product images to existing Shopify products.

**Read [`PROJECT_SPEC.md`](./PROJECT_SPEC.md) before making any change.**

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Supabase (`@supabase/ssr`)

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:3000
```

### Environment variables

| Name | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys → Publishable key (`sb_publishable_…`) |
| `NEXT_PUBLIC_SITE_URL` | Base URL of this app, e.g. `http://localhost:3000` |

Only browser-safe values exist so far. Server secrets are added in later phases (without the `NEXT_PUBLIC_` prefix).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types + `tsc --noEmit` |

## Structure

```
app/
├── layout.tsx, page.tsx, globals.css   # root layout, redirect, Tailwind theme
├── (auth)/                             # /login, /signup + server actions
├── auth/confirm, auth/error            # email-link handling
└── (app)/                              # protected area (sidebar + header shell)
    ├── dashboard/  stores/  stores/new/  drive-mapping/
    └── sync-jobs/  review/  activity/  settings/
components/
├── ui/        # shadcn/ui primitives
├── layout/    # app-sidebar, app-header, user-menu
├── shared/    # page-header, coming-soon
└── auth/      # auth card + form
lib/
├── utils.ts           # cn()
├── env.ts             # public env
├── env.server.ts      # server-only env (import "server-only")
├── auth.ts            # getSessionUser / requireUser (getClaims)
├── routes.ts          # public paths, safe ?next= redirects
├── navigation.ts      # sidebar items
└── supabase/          # client.ts (browser), server.ts, proxy.ts (session refresh)
hooks/                 # use-mobile
proxy.ts               # Next.js 16 proxy (formerly middleware)
public/
```

### Tailwind

Tailwind CSS 4 is configured CSS-first: there is no `tailwind.config.*`. The PostCSS plugin is set in `postcss.config.mjs`, and theme tokens (colors, radius, fonts) live in `app/globals.css` under `@theme`.

### Supabase MCP

`.mcp.json` registers the Supabase MCP server for Claude Code in this folder. Make sure its `project_ref` is `xkzccfxrixpyozfhamdh`.

## Security conventions

- Browser code only ever sees `NEXT_PUBLIC_*` values (Supabase URL + publishable key).
- Secrets live in `env.server.ts`; files that touch them import `server-only`.
- Server code verifies users with `supabase.auth.getClaims()`, never `getSession()`.
- Protected routes are checked twice: optimistically in `proxy.ts`, authoritatively in `(app)/layout.tsx`.
- `?next=` redirects are restricted to same-origin paths.

## Adding shadcn/ui components

`npx shadcn@latest add <component>` (config in `components.json`).
