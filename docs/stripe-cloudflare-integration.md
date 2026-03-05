# Integrating Stripe Payments with Cloudflare Workers (Next.js + OpenNext)

A comprehensive guide based on real-world experience migrating a Next.js SaaS application (LibraryOS) from Vercel to Cloudflare Workers, with full Stripe subscription billing.

> **Target audience**: Developers deploying Next.js apps to Cloudflare Workers via OpenNext who need Stripe checkout, subscriptions, webhooks, and billing portal.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Stripe Account & Product Setup](#3-stripe-account--product-setup)
4. [Server-Side Stripe Client (The Critical Part)](#4-server-side-stripe-client-the-critical-part)
5. [Checkout Session API](#5-checkout-session-api)
6. [Webhook Handler](#6-webhook-handler)
7. [Billing Portal](#7-billing-portal)
8. [Environment Variables: Two-Layer Architecture](#8-environment-variables-two-layer-architecture)
9. [Deployment Workflow](#9-deployment-workflow)
10. [Database-Driven Price Management](#10-database-driven-price-management)
11. [Pitfalls & Fixes](#11-pitfalls--fixes)
12. [Testing Checklist](#12-testing-checklist)
13. [Going Live](#13-going-live)

---

## 1. Architecture Overview

```
Browser (Client)
    |
    |  1. User clicks "Subscribe"
    v
Next.js API Route (/api/stripe/checkout)     -- runs inside Cloudflare Worker
    |
    |  2. Creates Stripe Checkout Session
    v
Stripe Checkout (hosted page)
    |
    |  3. User completes payment
    v
Stripe sends webhook POST
    |
    |  4. Event delivered to /api/stripe/webhook
    v
Next.js API Route (/api/stripe/webhook)      -- runs inside Cloudflare Worker
    |
    |  5. Updates database
    v
Supabase (PostgreSQL)
```

**Key constraint**: Cloudflare Workers is NOT Node.js. It's a V8 isolate runtime with limited Node.js API compatibility. The Stripe Node.js SDK assumes a full Node.js environment, which causes subtle but critical failures.

---

## 2. Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 18 | Local development |
| Next.js | >= 14 (App Router) | Framework |
| `stripe` npm package | >= 14.x | Stripe SDK |
| `@opennextjs/cloudflare` | Latest | Deploy Next.js to Workers |
| Wrangler CLI | >= 3.x | Manage Workers secrets & deployments |
| Stripe CLI | Latest | Create webhooks, test locally |

Install the Stripe SDK:

```bash
npm install stripe
```

---

## 3. Stripe Account & Product Setup

### 3a. Create Products and Prices

Use a setup script to create products programmatically. This ensures consistency and embeds metadata for plan detection.

```typescript
// scripts/setup-stripe.ts
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-04-30.basil',
})

const plans = [
    {
        name: 'Basic Plan',
        plan_id: 'basic',
        monthly: 99,   // cents
        yearly: 999,
    },
    {
        name: 'Pro Plan',
        plan_id: 'pro',
        monthly: 299,
        yearly: 2999,
    },
    {
        name: 'Enterprise Plan',
        plan_id: 'enterprise',
        monthly: 899,
        yearly: 8999,
    },
]

async function setup() {
    for (const plan of plans) {
        // Create product with plan_id in metadata
        const product = await stripe.products.create({
            name: plan.name,
            metadata: { plan_id: plan.plan_id },
        })

        // Create monthly price with plan_id in metadata
        const monthly = await stripe.prices.create({
            product: product.id,
            unit_amount: plan.monthly,
            currency: 'usd',
            recurring: { interval: 'month' },
            metadata: { plan_id: plan.plan_id },
        })

        // Create yearly price with plan_id in metadata
        const yearly = await stripe.prices.create({
            product: product.id,
            unit_amount: plan.yearly,
            currency: 'usd',
            recurring: { interval: 'year' },
            metadata: { plan_id: plan.plan_id },
        })

        console.log(`${plan.name}:`)
        console.log(`  Monthly: ${monthly.id}`)
        console.log(`  Yearly:  ${yearly.id}`)
    }
}

setup()
```

Run it:

```bash
STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/setup-stripe.ts
```

> **Important**: The `metadata: { plan_id: '...' }` on each price is critical. The webhook handler uses this to determine which plan was purchased, instead of hardcoding price IDs.

### 3b. Create Webhook Endpoint

Via Stripe CLI:

```bash
stripe webhook_endpoints create \
    --url "https://your-domain.com/api/stripe/webhook" \
    --enabled-events checkout.session.completed \
    --enabled-events customer.subscription.created \
    --enabled-events customer.subscription.updated \
    --enabled-events customer.subscription.deleted \
    --enabled-events invoice.paid \
    --enabled-events invoice.payment_failed
```

Or via the Stripe Dashboard: Developers > Webhooks > Add endpoint.

Save the webhook signing secret (`whsec_...`) — you'll need it for both GitHub Actions and Cloudflare Workers secrets.

---

## 4. Server-Side Stripe Client (The Critical Part)

This is where most Cloudflare Workers + Stripe integrations break. Create a single server-side Stripe module:

```typescript
// src/lib/stripe-server.ts
import Stripe from 'stripe'

const stripeSecretKey = process.env.STRIPE_SECRET_KEY

if (!stripeSecretKey) {
    console.warn('STRIPE_SECRET_KEY is not set. Stripe functionality will not work.')
}

export const stripe = stripeSecretKey
    ? new Stripe(stripeSecretKey, {
        apiVersion: '2025-04-30.basil',
        typescript: true,
        // ============================================================
        // CRITICAL FOR CLOUDFLARE WORKERS
        // Without this, the Stripe SDK uses node-fetch internally,
        // which relies on Node.js http/https modules. These modules
        // hang indefinitely in Cloudflare Workers even with the
        // nodejs_compat flag enabled. Using createFetchHttpClient()
        // forces the SDK to use the global fetch() API native to
        // the Workers runtime.
        // ============================================================
        httpClient: Stripe.createFetchHttpClient(),
    })
    : null

// ============================================================
// CRITICAL FOR CLOUDFLARE WORKERS (Webhook Verification)
// Workers uses WebCrypto API instead of Node.js crypto.
// The standard synchronous constructEvent() will fail.
// You MUST use constructEventAsync() with SubtleCryptoProvider.
// ============================================================
const webCryptoProvider = Stripe.createSubtleCryptoProvider()

export async function constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    webhookSecret: string
): Promise<Stripe.Event> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    return await stripe.webhooks.constructEventAsync(
        payload, signature, webhookSecret, undefined, webCryptoProvider
    )
}
```

### Why This Matters

The Stripe Node.js SDK has two HTTP client implementations:

| Client | Uses | Works in Workers? |
|--------|------|-------------------|
| Default (`NodeHttpClient`) | `node-fetch` -> Node.js `http` module | **NO** - hangs forever |
| `createFetchHttpClient()` | Global `fetch()` API | **YES** |

Similarly, webhook signature verification:

| Method | Uses | Works in Workers? |
|--------|------|-------------------|
| `constructEvent()` (sync) | Node.js `crypto` | **NO** - throws error |
| `constructEventAsync()` with `SubtleCryptoProvider` | WebCrypto API | **YES** |

---

## 5. Checkout Session API

```typescript
// src/app/api/stripe/checkout/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe-server'

export async function POST(request: NextRequest) {
    try {
        const { organizationId, planId, billingPeriod, userId } = await request.json()

        if (!organizationId || !planId || !billingPeriod || !userId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
        }

        if (!stripe) {
            return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
        }

        // 1. Look up user email for Stripe customer
        // 2. Get or create Stripe customer
        // 3. Look up price ID (from database, NOT from env vars — see Section 10)
        // 4. Create checkout session

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${baseUrl}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/billing?canceled=true`,
            metadata: {
                organization_id: organizationId,  // Used by webhook to find the org
            },
            allow_promotion_codes: true,
        })

        return NextResponse.json({ sessionId: session.id, url: session.url })
    } catch (error) {
        console.error('Checkout error:', error)
        return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
    }
}
```

### Client-Side Redirect

```typescript
// In your billing page component
async function handleSubscribe(planId: string, billingPeriod: string) {
    const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, planId, billingPeriod, userId }),
    })

    const data = await res.json()

    if (data.url) {
        window.location.href = data.url  // Redirect to Stripe Checkout
    }
}
```

---

## 6. Webhook Handler

```typescript
// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { stripe, constructWebhookEvent } from '@/lib/stripe-server'

export async function POST(request: NextRequest) {
    const body = await request.text()
    const signature = request.headers.get('stripe-signature')
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    if (!signature || !webhookSecret) {
        return NextResponse.json({ error: 'Missing signature or secret' }, { status: 400 })
    }

    let event
    try {
        // MUST use the async version for Cloudflare Workers
        event = await constructWebhookEvent(body, signature, webhookSecret)
    } catch (err) {
        console.error('Webhook signature verification failed:', err)
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }

    switch (event.type) {
        case 'checkout.session.completed':
            await handleCheckoutCompleted(event.data.object)
            break
        case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object)
            break
        case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(event.data.object)
            break
        case 'invoice.paid':
            await handleInvoicePaid(event.data.object)
            break
        case 'invoice.payment_failed':
            await handleInvoicePaymentFailed(event.data.object)
            break
    }

    return NextResponse.json({ received: true })
}

// Detect plan from price metadata instead of hardcoded price IDs
async function getPlanFromPriceId(priceId: string): Promise<string> {
    if (!stripe || !priceId) return 'free'
    try {
        const price = await stripe.prices.retrieve(priceId)
        return (price.metadata?.plan_id as string) || 'free'
    } catch {
        return 'free'
    }
}

async function handleCheckoutCompleted(session: any) {
    const organizationId = session.metadata?.organization_id
    if (!organizationId) return

    const subscription = await stripe!.subscriptions.retrieve(session.subscription)
    const priceId = subscription.items.data[0]?.price?.id
    const plan = await getPlanFromPriceId(priceId)

    // Update your database with:
    // - subscription_plan = plan
    // - subscription_status = subscription.status
    // - stripe_subscription_id = subscription.id
    // - stripe_price_id = priceId
    // - current_period_end = new Date(subscription.current_period_end * 1000)
}
```

### Key Design Decision: Metadata-Based Plan Detection

Instead of maintaining hardcoded price ID mappings:

```typescript
// BAD: Hardcoded price IDs — breaks on every account migration
const PRICE_TO_PLAN: Record<string, string> = {
    'price_1ABC...': 'basic',
    'price_1DEF...': 'pro',
}
```

Use price metadata set during product creation:

```typescript
// GOOD: Reads plan_id from Stripe price metadata
const price = await stripe.prices.retrieve(priceId)
const plan = price.metadata?.plan_id  // 'basic', 'pro', 'enterprise'
```

This survives account migrations, test/live mode switches, and price updates without code changes.

---

## 7. Billing Portal

```typescript
// src/app/api/stripe/portal/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe-server'

export async function POST(request: NextRequest) {
    const { customerId, returnUrl } = await request.json()

    if (!stripe) {
        return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
    }

    const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
    })

    return NextResponse.json({ url: session.url })
}
```

---

## 8. Environment Variables: Two-Layer Architecture

When deploying Next.js to Cloudflare Workers via OpenNext, environment variables come from **two different sources** depending on when they're accessed:

```
┌─────────────────────────────────────────────────┐
│  GitHub Actions Workflow (Build Time)            │
│                                                  │
│  NEXT_PUBLIC_* vars are inlined into JS bundles  │
│  during `next build`. They become string         │
│  literals in the output.                         │
│                                                  │
│  Source: GitHub Actions Secrets                   │
│  Set via: env: block in workflow YAML            │
└─────────────────────────────────────────────────┘
                      │
                      │  npm run build
                      v
┌─────────────────────────────────────────────────┐
│  Cloudflare Workers Runtime                      │
│                                                  │
│  Server-side process.env.* vars are read at      │
│  request time. They come from Workers secrets,   │
│  NOT from the build environment.                 │
│                                                  │
│  Source: Cloudflare Workers Secrets               │
│  Set via: npx wrangler secret put <NAME>         │
└─────────────────────────────────────────────────┘
```

### What Goes Where

| Variable | Build-Time (GitHub) | Runtime (Cloudflare) | Why |
|----------|:-------------------:|:--------------------:|-----|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Yes | No | Inlined into client JS at build |
| `NEXT_PUBLIC_APP_URL` | Yes | No | Used in client components |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | No | Used in client components |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | No | Used in client components |
| `STRIPE_SECRET_KEY` | No* | **Yes** | Read at request time in API routes |
| `STRIPE_WEBHOOK_SECRET` | No* | **Yes** | Read at request time in webhook |
| `SUPABASE_SERVICE_ROLE_KEY` | No* | **Yes** | Read at request time in API routes |

\* These may also be set at build time if your build process needs them, but the **runtime** value is what matters for API routes.

### Setting Cloudflare Workers Secrets

```bash
# Interactive prompt (paste the value)
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Verify secrets are set
npx wrangler secret list
```

### Setting GitHub Actions Secrets

Go to your repo: Settings > Secrets and variables > Actions, and add:

```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_test_...
NEXT_PUBLIC_APP_URL = https://your-domain.com
NEXT_PUBLIC_SUPABASE_URL = https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY = eyJ...
```

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy-cloudflare.yml
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci

      - name: Build
        env:
          # Build-time variables (NEXT_PUBLIC_* are inlined)
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}
          NEXT_PUBLIC_APP_URL: ${{ secrets.NEXT_PUBLIC_APP_URL }}
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
          # Also set server-side vars if build process references them
          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
          STRIPE_WEBHOOK_SECRET: ${{ secrets.STRIPE_WEBHOOK_SECRET }}
        run: npm run build

      - name: Deploy to Cloudflare
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: npx wrangler deploy
```

---

## 9. Deployment Workflow

### Initial Setup

1. Create Stripe products and prices (Section 3a)
2. Create webhook endpoint (Section 3b)
3. Set GitHub Actions secrets (Section 8)
4. Set Cloudflare Workers secrets (Section 8)
5. Store price IDs in your database (Section 10)
6. Push code to trigger deployment

### Redeployment

After code changes, just push to your main branch. The GitHub Actions workflow builds and deploys automatically.

After changing **server-side** secrets (e.g., rotating Stripe keys):

```bash
# Update the Workers secret
npx wrangler secret put STRIPE_SECRET_KEY
# Then trigger a new deployment (wrangler deploy or git push)
```

After changing **build-time** variables (e.g., publishable key):

```
# Update GitHub Actions secret, then re-run the workflow
```

---

## 10. Database-Driven Price Management

Instead of putting Stripe price IDs in environment variables (which requires redeployment to change), store them in your database:

```sql
CREATE TABLE subscription_plans (
    plan_id VARCHAR PRIMARY KEY,       -- 'basic', 'pro', 'enterprise'
    name VARCHAR NOT NULL,
    max_books INTEGER,
    max_users INTEGER,
    price_monthly INTEGER,             -- display price in cents
    price_yearly INTEGER,
    stripe_price_id_monthly VARCHAR,   -- 'price_1ABC...'
    stripe_price_id_yearly VARCHAR,    -- 'price_1DEF...'
    is_active BOOLEAN DEFAULT true
);
```

In your checkout API, read the price ID from the database:

```typescript
const priceColumn = billingPeriod === 'yearly' ? 'stripe_price_id_yearly' : 'stripe_price_id_monthly'
const { data } = await supabase
    .from('subscription_plans')
    .select(priceColumn)
    .eq('plan_id', planId)
    .single()

const priceId = data?.[priceColumn]
```

**Benefits**:
- Change prices without redeploying
- Switch between test/live price IDs via database update
- No environment variable proliferation (`STRIPE_PRICE_BASIC_MONTHLY_TEST`, etc.)

---

## 11. Pitfalls & Fixes

### Pitfall 1: Stripe SDK Hangs in Cloudflare Workers (CRITICAL)

**Symptom**: API routes that call Stripe never return. The request hangs until timeout. No error is thrown.

**Root cause**: The Stripe Node.js SDK defaults to `NodeHttpClient`, which uses `node-fetch`, which uses Node.js `http`/`https` modules. Even with `nodejs_compat` enabled in `wrangler.jsonc`, these modules don't work correctly in Workers — HTTP requests hang indefinitely.

**Fix**:

```typescript
const stripe = new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),  // <-- ADD THIS
})
```

This tells the SDK to use the global `fetch()` API, which is native to the Workers runtime and works perfectly.

**How to diagnose**: If you suspect this issue, test with a raw `fetch()` call:

```typescript
// If this works but Stripe SDK calls hang, it's the HTTP client issue
const resp = await fetch('https://api.stripe.com/v1/customers?limit=1', {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
})
const data = await resp.json()
```

### Pitfall 2: Webhook Signature Verification Fails

**Symptom**: `stripe.webhooks.constructEvent()` throws a crypto-related error.

**Root cause**: The synchronous `constructEvent()` uses Node.js `crypto` module, which isn't available in Workers.

**Fix**:

```typescript
const webCryptoProvider = Stripe.createSubtleCryptoProvider()

// Use the ASYNC version
const event = await stripe.webhooks.constructEventAsync(
    payload, signature, secret, undefined, webCryptoProvider
)
```

### Pitfall 3: Environment Variables Not Available at Runtime

**Symptom**: `process.env.STRIPE_SECRET_KEY` is `undefined` in API routes, even though it's set in GitHub Actions secrets.

**Root cause**: GitHub Actions secrets are only available at **build time**. Server-side `process.env` in Cloudflare Workers reads from **Workers secrets**, which are set separately.

**Fix**: Set runtime secrets via Wrangler:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# Paste the key when prompted
```

### Pitfall 4: `NEXT_PUBLIC_` Variables Empty on Client

**Symptom**: Client-side code reads `process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` as empty string or undefined.

**Root cause**: `NEXT_PUBLIC_*` variables are replaced at **build time** by Next.js. If they weren't set in the build environment, they're permanently empty in the built output.

**Fix**: Ensure they're set in the `env:` block of your GitHub Actions build step:

```yaml
- name: Build
  env:
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}
  run: npm run build
```

### Pitfall 5: Hardcoded Price IDs Break on Migration

**Symptom**: After migrating Stripe accounts or switching between test/live mode, webhook handler doesn't recognize new price IDs and defaults everything to "free".

**Root cause**: Price IDs like `price_1ABC...` are hardcoded in arrays.

**Fix**: Use metadata-based plan detection (see Section 6) and database-driven price management (see Section 10).

### Pitfall 6: Stripe CLI `--api-key` Ignored

**Symptom**: When running Stripe CLI commands with `--api-key`, the CLI still operates on the logged-in profile's account instead of the specified key's account.

**Root cause**: Stripe CLI prioritizes the authenticated profile over the `--api-key` flag for certain commands.

**Fix**: Use `curl` with the `Authorization` header for account-specific operations:

```bash
curl -X DELETE https://api.stripe.com/v1/webhook_endpoints/we_xxx \
    -H "Authorization: Bearer sk_test_..."
```

### Pitfall 7: Stripe CLI Webhook Create Event Syntax

**Symptom**: `stripe webhook_endpoints create --enabled-events "evt1,evt2"` doesn't work.

**Fix**: Use separate flags for each event:

```bash
stripe webhook_endpoints create \
    --url "https://example.com/webhook" \
    --enabled-events checkout.session.completed \
    --enabled-events customer.subscription.updated
```

### Pitfall 8: `nodejs_compat` Flag Gives False Confidence

**Symptom**: You add `"compatibility_flags": ["nodejs_compat"]` to `wrangler.jsonc` and assume Node.js APIs work.

**Reality**: `nodejs_compat` provides **partial** Node.js API support. Many modules (including `http`, `https`, `net`) are stubbed or incomplete. Code that uses them may compile and even start executing, but then hang or throw at runtime.

**Rule of thumb**: Always prefer Web Standard APIs (`fetch`, `crypto.subtle`, `ReadableStream`, etc.) over Node.js APIs in Workers.

---

## 12. Testing Checklist

### Local Testing

```bash
# 1. Start your dev server
npm run dev

# 2. Forward Stripe webhooks to localhost
stripe listen --forward-to localhost:3000/api/stripe/webhook

# 3. Test checkout flow in browser
# 4. Use test card: 4242 4242 4242 4242
```

### Production Testing (Test Mode)

1. Deploy with test mode keys (`sk_test_...`, `pk_test_...`)
2. Navigate to billing page
3. Select a plan and click Subscribe
4. Complete checkout with test card `4242 4242 4242 4242`
5. Verify in Stripe Dashboard:
   - Customer created
   - Subscription active
   - Webhook delivery successful (200 response)
6. Verify in your database:
   - Organization's `subscription_plan` updated
   - `subscription_status` is `active` or `trialing`
   - `stripe_subscription_id` populated
7. Test billing portal access
8. Test plan upgrade/downgrade
9. Test subscription cancellation

### Common Test Cards

| Card Number | Scenario |
|-------------|----------|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 3220` | 3D Secure authentication required |
| `4000 0000 0000 9995` | Payment declined |
| `4000 0000 0000 0341` | Attaching card fails |

---

## 13. Going Live

1. **Create live products and prices**:
   ```bash
   STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/setup-stripe.ts
   ```

2. **Create live webhook endpoint** pointing to your production URL

3. **Update Cloudflare Workers secrets**:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY      # sk_live_...
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... (live)
   ```

4. **Update GitHub Actions secrets**:
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` = `pk_live_...`

5. **Update database** `subscription_plans` table with live price IDs

6. **Redeploy**: Push a commit or manually trigger the workflow

7. **Verify**: Make a real $1 test purchase, then refund it

---

## Quick Reference: Cloudflare Workers Compatibility

| Stripe SDK Feature | Standard (Node.js) | Cloudflare Workers |
|--------------------|--------------------|--------------------|
| HTTP client | `new Stripe(key)` | `new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })` |
| Webhook verification | `stripe.webhooks.constructEvent(...)` | `stripe.webhooks.constructEventAsync(..., Stripe.createSubtleCryptoProvider())` |
| Environment variables | `process.env.X` | `process.env.X` (but set via `wrangler secret put`) |
| `NEXT_PUBLIC_*` vars | Set at build time | Set at build time (in CI) |

---

## Summary

The two critical lines that make Stripe work in Cloudflare Workers:

```typescript
// 1. Use fetch-based HTTP client (prevents hanging)
httpClient: Stripe.createFetchHttpClient()

// 2. Use async webhook verification with WebCrypto (prevents crypto errors)
await stripe.webhooks.constructEventAsync(
    payload, signature, secret, undefined, Stripe.createSubtleCryptoProvider()
)
```

Everything else is standard Stripe integration. The Workers runtime is almost fully compatible — you just need to explicitly opt into Web Standard APIs where the SDK defaults to Node.js-specific ones.
