import { NextResponse } from 'next/server'

export async function GET() {
    const info: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
        stripe_key_prefix: process.env.STRIPE_SECRET_KEY?.substring(0, 20) || 'NOT SET',
        node_env: process.env.NODE_ENV,
        app_url: process.env.NEXT_PUBLIC_APP_URL,
    }

    // Test Stripe API using raw fetch (no SDK)
    const key = process.env.STRIPE_SECRET_KEY
    if (key) {
        try {
            const resp = await fetch('https://api.stripe.com/v1/customers?limit=1', {
                headers: { 'Authorization': `Bearer ${key}` },
            })
            const data = await resp.json()
            info.stripe_raw_fetch_works = true
            info.stripe_status = resp.status
            info.customer_count = (data as { data?: unknown[] }).data?.length ?? 0
        } catch (e) {
            info.stripe_raw_fetch_works = false
            info.stripe_raw_fetch_error = e instanceof Error ? e.message : String(e)
        }
    }

    return NextResponse.json(info)
}
