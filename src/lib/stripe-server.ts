import Stripe from 'stripe'

// Server-side Stripe client
// Uses STRIPE_SECRET_KEY for server operations
const stripeSecretKey = process.env.STRIPE_SECRET_KEY

if (!stripeSecretKey) {
    console.warn('STRIPE_SECRET_KEY is not set. Stripe functionality will not work.')
}

// Only create Stripe client if API key is available
export const stripe = stripeSecretKey
    ? new Stripe(stripeSecretKey, {
        apiVersion: '2025-04-30.basil',
        typescript: true,
    })
    : null

// Price IDs from your Stripe Dashboard
// These should match the products you create in Stripe
export const STRIPE_PRICES = {
    // Development/Test prices (from Stripe Test Mode)
    test: {
        basic_monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY_TEST || '',
        basic_yearly: process.env.STRIPE_PRICE_BASIC_YEARLY_TEST || '',
        pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY_TEST || '',
        pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY_TEST || '',
        enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY_TEST || '',
        enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY_TEST || '',
    },
    // Production prices (from Stripe Live Mode)
    production: {
        basic_monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY || '',
        basic_yearly: process.env.STRIPE_PRICE_BASIC_YEARLY || '',
        pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || '',
        pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY || '',
        enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || '',
        enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || '',
    },
}

// Helper to get the right price based on environment
export function getStripePrices() {
    const isProduction = process.env.NODE_ENV === 'production' &&
                         !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')
    return isProduction ? STRIPE_PRICES.production : STRIPE_PRICES.test
}

// Plan price mapping (Africa-friendly pricing)
export const PLAN_PRICES = {
    basic: { monthly: 0.99, yearly: 9.99 },
    pro: { monthly: 2.99, yearly: 29.99 },
    enterprise: { monthly: 8.99, yearly: 89.99 },
}

// Create or retrieve a Stripe customer
export async function getOrCreateStripeCustomer(
    email: string,
    name: string,
    metadata?: Record<string, string>
): Promise<string> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    // First, try to find existing customer by email
    const existingCustomers = await stripe.customers.list({
        email,
        limit: 1,
    })

    if (existingCustomers.data.length > 0) {
        return existingCustomers.data[0].id
    }

    // Create new customer
    const customer = await stripe.customers.create({
        email,
        name,
        metadata,
    })

    return customer.id
}

// Force create a new Stripe customer (ignores existing)
export async function createNewStripeCustomer(
    email: string,
    name: string,
    metadata?: Record<string, string>
): Promise<string> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    const customer = await stripe.customers.create({
        email,
        name,
        metadata,
    })

    return customer.id
}

// Create a checkout session for subscription
export async function createCheckoutSession(params: {
    customerId: string
    priceId: string
    organizationId: string
    successUrl: string
    cancelUrl: string
    trialDays?: number
}): Promise<Stripe.Checkout.Session> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    const session = await stripe.checkout.sessions.create({
        customer: params.customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
            {
                price: params.priceId,
                quantity: 1,
            },
        ],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        subscription_data: params.trialDays
            ? { trial_period_days: params.trialDays }
            : undefined,
        metadata: {
            organization_id: params.organizationId,
        },
        allow_promotion_codes: true,
    })

    return session
}

// Create a billing portal session
export async function createBillingPortalSession(
    customerId: string,
    returnUrl: string
): Promise<Stripe.BillingPortal.Session> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
    })

    return session
}

// Cancel subscription
export async function cancelSubscription(
    subscriptionId: string,
    cancelImmediately: boolean = false
): Promise<Stripe.Subscription> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    if (cancelImmediately) {
        return await stripe.subscriptions.cancel(subscriptionId)
    } else {
        return await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        })
    }
}

// Resume a canceled subscription
export async function resumeSubscription(
    subscriptionId: string
): Promise<Stripe.Subscription> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    return await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
    })
}

// Update subscription to a new plan
export async function updateSubscription(
    subscriptionId: string,
    newPriceId: string
): Promise<Stripe.Subscription> {
    if (!stripe) {
        throw new Error('Stripe is not configured')
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId)

    return await stripe.subscriptions.update(subscriptionId, {
        items: [
            {
                id: subscription.items.data[0].id,
                price: newPriceId,
            },
        ],
        proration_behavior: 'create_prorations',
    })
}

// Get subscription details
export async function getSubscription(
    subscriptionId: string
): Promise<Stripe.Subscription | null> {
    if (!stripe) {
        return null
    }

    try {
        return await stripe.subscriptions.retrieve(subscriptionId)
    } catch {
        return null
    }
}

// WebCrypto provider for Cloudflare Workers compatibility
const webCryptoProvider = Stripe.createSubtleCryptoProvider()

// Construct webhook event (async for Cloudflare Workers WebCrypto compatibility)
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
