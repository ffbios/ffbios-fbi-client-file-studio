# CEO launch readiness — FBI Client File Studio

**Release status (10 October 2026):** the security/egress hardening and approved public pricing are merged to `main` and deployed to Railway production. The application health check passed and all application/streaming services report `SUCCESS`. Creator, Professional and Studio public prices are live. Existing subscription rows and complimentary grants were not mass-updated by the price seed update.

## CEO decision

Treat the platform as a controlled commercial launch. Preserve the original-media/upload engine, reduce paid application egress, protect account and contact data, price storage based on usage economics, and verify payment/recovery procedures before scaling acquisition.

## Applied engineering safeguards

- Rate limits cover admin sign-in, portal sign-in, registration, gallery access, and authenticated checkout creation.
- Express trusts one Railway proxy hop for IP detection. Verify this topology if it changes.
- Email typed by a client to open a bearer-link gallery no longer overwrites the owner's saved project client email.
- Authenticated admin/portal thumbnails redirect to signed private-bucket URLs once authorization is confirmed. The existing upload engine and original-media routes remain unchanged.
- The current-plan API returns the subscriber's recorded quota and price snapshot; plan cards display that recorded price for the active subscription. New purchases, upgrades and renewals use the currently published plan prices.
- Current subscriptions remain at their recorded price until their existing billing period expires; the published new rate applies when they renew or choose another plan. The application uses manual Moolre checkout, not automatic recurring charges.
- Complimentary Studio records remain complimentary, and current account entitlements are not mass-updated by the public plan-price seed.

### Technical limitations and release gates

- The rate-limit counters are in-process. Replace them with shared storage before using multiple application replicas.
- Password reset/email verification is not confirmed as available. Implement after setting up a working email delivery provider; never expose a reset code in a response or ordinary logs.
- Gallery links remain bearer credentials. Optional passcodes, OTP or client-email allowlists should be added for sensitive deliveries.
- A real low-value Moolre payment and reconciliation test has not been run as part of this code release. Do not mark payment acceptance complete until the provider status endpoint, webhook, payment ledger, and subscription activation have all been confirmed from a paying test account.
- A separate Railway backup worker (`fbi-client-file-studio-db-backup`) is configured to run daily at 03:15 UTC, writing PostgreSQL custom-format dumps to a separate private bucket. The first archive was validated with `pg_restore --list` and uploaded at 1,592,834 bytes on 10 October 2026. This confirms archive creation and object upload, not a full restore test. Restore a copy into a disposable test database and verify key tables/counts before calling disaster recovery fully tested.
- The PostgreSQL backup job does not copy the original-media bucket. Confirm original media can be recovered separately; do not assume database backup protects stored originals.
- Continue to inspect 4xx by route and user action. Not all 4xx errors indicate defects.

## Current public plan prices

| Plan | Storage quota | Monthly price |
|---|---:|---:|
| Starter | 100 GB | GH₵50 |
| Creator | 500 GB | GH₵150 |
| Professional | 1 TB | GH₵300 |
| Studio | 2 TB | GH₵550 |

The 10 GB Free Trial remains GH₵0 for its trial period. These rates are public plan prices in the release. A user's currently active subscription keeps its recorded price/quota for the remainder of its current period. At its expiry, a new Moolre checkout is required at the current public rate.

## Storage unit economics

Current Railway bucket documentation prices storage at US$0.015 per GB-month (30 days) and states that bucket egress and S3 API operations are free. Uploads originating from a Railway application can still incur service egress. Source: https://docs.railway.com/storage-buckets/billing

The Bank of Ghana's 9 October 2026 USD/GHS mid reference rate was GH₵11.79 per US$1. Source: https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/

Using that rate, full allowance occupancy for a whole 30-day month costs:

| Plan | Full quota | Bucket cost at full quota | Public price | Remainder after bucket storage only |
|---|---:|---:|---:|---:|
| Starter | 100 GB | GH₵17.69 | GH₵50 | GH₵32.31 |
| Creator | 500 GB | GH₵88.43 | GH₵150 | GH₵61.57 |
| Professional | 1,000 GB | GH₵176.85 | GH₵300 | GH₵123.15 |
| Studio | 2,000 GB | GH₵353.70 | GH₵550 | GH₵196.30 |

These are conservative full-occupancy scenarios, not statements about current customer usage. Actual storage charges follow average actual stored GB-month, not unused entitlements. The remainder is not net profit: it must also cover compute, remaining service egress, payment fees, support, tax and exchange-rate movements.

## Operating policy

1. Record monthly stored GB by user and plan; review high storage use at 70%, 85% and 95% of quota.
2. Do not change existing subscription records, take away promised complimentary storage, delete files, or introduce overage fees without a clear policy and intentional implementation.
3. Communicate plan price/renewal changes clearly. Users must see the charge before leaving to Moolre.
4. Do not advertise unlimited storage. Publish limits, renewal process, expiry handling, file-retention and privacy rules.
5. Consider annual prepay only after real Moolre reconciliation, receipt and reminder handling have been verified.
6. Inspect Railway resource usage/egress alongside the stored-byte totals. Redirecting media helps lower service egress but does not eliminate compute, upload egress or database costs.

## Next operational checks

1. Verify production sign-in and test file upload/resume, thumbnail display, original-media playback/download, client selection and share expiration using a non-critical test project.
2. Complete one low-value test payment from a separate paying account and confirm provider verification, webhook delivery, ledger status and quota activation.
3. Verify PostgreSQL backup and complete a restore test in a safe environment.
4. Confirm recovery of original media from the private bucket.
5. Replace in-process rate limits before horizontal scaling.
