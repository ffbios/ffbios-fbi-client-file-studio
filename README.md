# FBI Client File Studio

Cloud client-delivery platform for photographers, videographers and creative studios.

## Production portal

**Client / creative portal:** https://files.fbigh.com/portal

The current application is a Node.js/Express service deployed on Railway. This repository's legacy GitHub Pages/Supabase setup notes were outdated and should not be used to configure production.

## Architecture

- **Application/API:** Node.js 22+ and Express (server.js).
- **Database:** PostgreSQL using Railway's DATABASE_URL.
- **File storage:** private S3-compatible Railway Bucket. Large uploads use resumable/multipart support.
- **Hosting and deployments:** Railway, connected to this repository.
- **Billing:** Moolre checkout, server-verified payment status and webhook processing.
- **Portal UI:** site/portal.html; public client galleries use tokenized share links.

The platform is designed to retain original uploaded files. Thumbnails and preview images are derived assets; they are not replacements for the original media.

## Local development

Requirements: Node.js 22 or newer and access to a configured PostgreSQL database and S3-compatible bucket.

    npm install
    npm start

The service listens on the port provided by PORT. For a functioning application, configure the runtime variables below through your deployment environment, not by committing secrets.

## Runtime configuration

The primary Railway variables include:

- DATABASE_URL
- SESSION_SECRET
- S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
- PUBLIC_BASE_URL
- MOOLRE_API_USER, MOOLRE_API_PUBKEY, MOOLRE_ACCOUNT_NUMBER
- Optional Moolre settings: MOOLRE_API_BASE, MOOLRE_BUSINESS_EMAIL, MOOLRE_CURRENCY, MOOLRE_WEBHOOK_SECRET, MOOLRE_VERIFY_WEBHOOK
- Admin access settings: ADMIN_EMAIL and ADMIN_PASSWORD where applicable.

Never commit secret values or send them to a client/browser. Keep database and bucket credentials server-side. Use a stable, high-entropy SESSION_SECRET; changing it invalidates existing sessions.

## Security and operational notes

- Authentication sessions use signed, HTTP-only, secure cookies.
- Login and registration throttles have been added in the CEO launch-hardening branch. They use an in-process store, so move rate limiting to a shared store before scaling the application to multiple replicas.
- A public gallery share link acts as a bearer credential. Do not distribute a sensitive gallery link publicly. The email entered on the gallery access screen is not verified and is no longer allowed to overwrite the owner's saved client-contact email.
- A password-recovery/email-verification workflow is not documented as available yet; do not promise either until implemented and tested.
- Test both a paid Moolre transaction and webhook/status reconciliation with a real low-value payment before relying on subscription revenue. Do not activate a subscription on a browser redirect alone.
- Confirm automated PostgreSQL backups and complete a restore test. Also confirm that original media can be recovered from object storage before onboarding large client archives.
- Do not change the public storage plan prices or quotas without checking current subscriber entitlements and communicating renewal terms.

## Current storage prices

Current configured prices are seeded in server.js and synchronized to the subscription_plans table at app startup:

| Plan | Storage quota | Monthly price |
|---|---:|---:|
| Starter | 100 GB | GH₵50 |
| Creator | 500 GB | GH₵150 |
| Professional | 1 TB | GH₵300 |
| Studio | 2 TB | GH₵550 |

Price transition and storage unit economics are documented in docs/CEO-launch-readiness.md. Existing active subscriptions keep their recorded price and quota until their current period ends; new purchases, upgrades and renewals use the published plan rates. Complimentary grants remain unchanged.

## Release checklist

1. Verify production health and sign-in on desktop and mobile.
2. Test upload, resume, preview, download, and client sharing using a non-critical test project.
3. Verify Moolre checkout, webhook verification, pending-payment reconciliation, and subscription activation end to end.
4. Check object-storage and PostgreSQL backup/restore procedures.
5. Inspect Railway resource usage and failed HTTP requests after a release.
6. Before horizontal scaling, replace the in-process rate-limit store with a shared implementation.
