# FBI Client File Studio

Cloud client-delivery system for Film Beyond Imagination (FBI).

## Live application

The frontend is deployed from the `site/` directory with GitHub Pages.

Expected URL:

`https://ffbios.github.io/ffbios-fbi-client-file-studio/`

## Architecture

- GitHub Pages hosts the studio frontend.
- Supabase Auth handles studio login.
- Supabase Postgres stores projects, file records, share links and download records.
- Supabase Storage holds the private client-file bucket.
- A Supabase Edge Function validates public share tokens and returns temporary signed URLs.

## One-time Supabase setup

1. Open your Supabase project.
2. Run `supabase/file-studio-supabase-setup.sql` in the SQL Editor.
3. Deploy `supabase/functions/client-delivery/index.ts` as an Edge Function named `client-delivery`.
4. Keep the service-role/secret key only in Supabase server-side secrets. Never place it in `site/index.html`.
5. Use only the Supabase publishable key in the browser.

## Using the studio

1. Open the live GitHub Pages URL.
2. Enter the Supabase Project URL and Publishable Key.
3. Create or sign in to your cloud account.
4. Create a client project.
5. Upload photos, videos or other deliverables.
6. Create a share link.
7. Send that link to the client.

The client can open the link without a Supabase account. The delivery function validates the token and creates a temporary signed URL for the requested file.

## Large media

The studio uses resumable uploads for larger media and standard uploads for smaller files.

## Deployment

Every push to `main` triggers GitHub Actions and publishes the `site/` directory to GitHub Pages.

Workflow: `.github/workflows/deploy-pages.yml`

<!-- Pages deployment configured for GitHub Actions. -->
