# CEO launch readiness — FBI Client File Studio

**Status:** staged recommendations. The engineering changes in this branch are not live until the branch is merged and the Railway production deployment succeeds. Proposed plan prices below are not live.

## CEO decision

The product has a useful foundation for creative client delivery, but it should be treated as a controlled commercial launch rather than scaled with paid advertising immediately. Priority is account protection, truthful billing, file-delivery cost, reliable recovery, and clear plan economics.

## Included in the hardening change

1. **Throttle expensive/abusable routes:** in-memory per-IP limits for admin sign-in, portal sign-in, registration and gallery access; a per-user limit for payment-checkout creation. Requests over the limit receive HTTP 429 and a retry interval.
2. **Trust the Railway proxy correctly for client IP detection:** Express is configured for one trusted proxy hop. Verify this assumption if the traffic topology changes.
3. **Protect project contact data:** an email typed by a client to open a bearer-link gallery now remains only in that signed gallery session and client-selection records. It no longer overwrites the owner's stored projects.client_email without verification.
4. **Reduce thumbnail service egress:** once authorization is checked, authenticated portal/admin thumbnail routes redirect to signed object-bucket URLs instead of returning cached/stored image bytes through the app. The redirect is marked private/no-store; bucket responses can still use object-level cache policy.
5. **Keep the main media/upload engine untouched:** these changes do not alter original uploads, resumable upload sessions, project ownership rules, source video delivery, or the payment activation logic.

### Limitations to resolve before broader scale

- Rate-limit state is local to one app instance. Replace with shared storage before running multiple replicas; otherwise an attacker can get a separate limit per replica.
- No working password-recovery or email-verification flow has been confirmed in the current portal. Implement these after choosing an email delivery provider, rather than showing a nonfunctional reset link.
- Gallery links are bearer credentials. Add optional passcodes, OTP or client-email allowlists for sensitive projects before positioning the product for regulated/confidential use.
- Automated Postgres backup, object-storage restore, and a complete real-money Moolre payment/reconciliation test still need explicit verification.
- Monitor route-level HTTP 4xx/5xx and actual Railway egress/storage figures. Do not assume every 4xx is an application defect.

## Storage-cost math

Railway's current documentation states that buckets cost **US$0.015 per GB-month** and that bucket egress and S3 API operations are free. The Bank of Ghana's 9 October 2026 USD/GHS mid reference rate is **GH₵11.79 per US$1**. Reference sources:

- Railway Bucket billing: https://docs.railway.com/storage-buckets/billing
- Railway compute/egress pricing: https://docs.railway.com/pricing/plans
- Bank of Ghana daily interbank rates: https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/

This means bucket storage is approximately **GH₵0.17685 per stored GB-month** at that exchange reference rate. Calculations below assume every allowance is filled for an entire 30-day month and use decimal GB/TB; this is a conservative full-utilization scenario, not a claim about current real usage.

| Current plan | Quota | Current monthly price | Bucket cost at full quota | Storage-only result before compute, payments and support |
|---|---:|---:|---:|---:|
| Starter | 100 GB | GH₵50 | GH₵17.69 | +GH₵32.31 |
| Creator | 500 GB | GH₵80 | GH₵88.43 | −GH₵8.43 |
| Professional | 1,000 GB | GH₵120 | GH₵176.85 | −GH₵56.85 |
| Studio | 2,000 GB | GH₵180 | GH₵353.70 | −GH₵173.70 |

Actual bucket cost follows stored data rather than the user's unused entitlement. At the current price and the full-utilization assumption, Creator becomes storage-only negative above roughly 452 GB, Professional above roughly 679 GB, and Studio above roughly 1,018 GB. Compute, service egress for any bytes still served through the app, payment fees, support, taxes and FX variation reduce the remaining margin further.

## Recommended public pricing proposal — not applied

Keep the current Starter entry point affordable, and price higher capacities to cover a high-utilization account without relying on every customer to use very little storage:

| Recommended plan | Storage quota | Proposed monthly price | Bucket cost at full quota | Gross remainder before other costs |
|---|---:|---:|---:|---:|
| Starter | 100 GB | GH₵50 | GH₵17.69 | GH₵32.31 |
| Creator | 500 GB | GH₵150 | GH₵88.43 | GH₵61.57 |
| Professional | 1 TB | GH₵300 | GH₵176.85 | GH₵123.15 |
| Studio | 2 TB | GH₵550 | GH₵353.70 | GH₵196.30 |

These are recommended prices, not edits to the live plan table. The full-capacity figures leave around 36–41% of revenue after bucket storage on the upper tiers, before every other cost; actual economics should be checked against real user storage usage and the Railway bill.

### How to introduce the new prices safely

1. **Do not revoke complimentary or existing storage grants.** The current subscription row stores a separate entitlement. Keep each existing account's current quota/period intact.
2. **Publish a clear change notice before renewing existing paid users at new rates.** Grandfather existing paid accounts for an agreed period or until their current paid period ends; do not surprise users at checkout.
3. **Apply the new prices only after approval.** The app seeds subscription_plans on startup. Changing seed values is a customer-facing price change, so it needs an intentional release and a UI/terms update.
4. **Track used GB per plan weekly.** Flag accounts using more than 70%, 85% and 95% of quota and aggregate real stored GB-month. Do not charge overages or delete data without a published policy and explicit implementation.
5. **Offer annual prepay later, not now.** First verify Moolre payment reconciliation, receipts, failed-payment handling and renewal reminders. Current checkout uses a non-reusable checkout and should be treated as manual monthly renewal unless an automated renewal integration is separately implemented.
6. **Do not advertise "unlimited" or guarantee a 2TB cost-free transfer service.** State storage quotas, file-retention rules, download/share behavior, renewal timing, and what happens after expiry before paid launch.

## Next release gates

- Deploy this branch only after syntax/build verification and confirm the Railway deployment is healthy.
- Smoke-test admin sign-in, user register/login, gallery access, thumbnail loading, original-media playback/download, upload resume and client picks.
- Run an actual low-value Moolre test using a non-complimentary paying account and verify both webhook and server-side status-check activation.
- Verify Postgres backup plus restore and recovery of stored originals.
- Decide/approve a pricing effective date before changing the seeded live prices.
