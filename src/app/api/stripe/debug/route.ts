import { NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe-server'

export async function GET() {
    const info: Record<string, unknown> = {
        stripe_key_set: !!process.env.STRIPE_SECRET_KEY,
        stripe_key_prefix: process.env.STRIPE_SECRET_KEY?.substring(0, 20) || 'NOT SET',
        stripe_client_initialized: !!stripe,
        node_env: process.env.NODE_ENV,
        app_url: process.env.NEXT_PUBLIC_APP_URL,
        supabase_url_set: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
        webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    }

    // Try a simple Stripe API call
    if (stripe) {
        try {
            const acct = await stripe.accounts.retrieve()
            info.stripe_account_id = acct.id
            info.stripe_works = true
        } catch (e) {
            info.stripe_works = false
            info.stripe_error = e instanceof Error ? e.message : String(e)
        }
    }

    return NextResponse.json(info)
}
