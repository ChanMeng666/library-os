import { NextResponse } from 'next/server'
import Stripe from 'stripe'

export async function GET() {
    const info: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
        stripe_key_prefix: process.env.STRIPE_SECRET_KEY?.substring(0, 20) || 'NOT SET',
        node_env: process.env.NODE_ENV,
        app_url: process.env.NEXT_PUBLIC_APP_URL,
    }

    // Try creating Stripe client directly (bypass stripe-server.ts)
    const key = process.env.STRIPE_SECRET_KEY
    if (key) {
        try {
            info.step = 'creating client'
            const stripeClient = new Stripe(key, { apiVersion: '2025-04-30.basil' })
            info.step = 'calling customers.list'
            const customers = await stripeClient.customers.list({ limit: 1 })
            info.stripe_works = true
            info.customer_count = customers.data.length
            info.step = 'done'
        } catch (e) {
            info.stripe_works = false
            info.stripe_error = e instanceof Error ? e.message : String(e)
        }
    } else {
        info.stripe_works = false
        info.stripe_error = 'STRIPE_SECRET_KEY not set'
    }

    return NextResponse.json(info)
}
