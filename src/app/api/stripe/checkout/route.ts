import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
    stripe,
    getOrCreateStripeCustomer,
    createNewStripeCustomer,
    createCheckoutSession,
} from '@/lib/stripe-server'

// Create Supabase client with service role for server operations
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
    // DEBUG: collect step-by-step logs to return to client
    const debug: string[] = []
    const log = (msg: string) => { debug.push(`[${new Date().toISOString()}] ${msg}`); console.log(msg) }

    try {
        const body = await request.json()
        const { organizationId, planId, billingPeriod, userId } = body
        log(`STEP 0: params planId=${planId} billingPeriod=${billingPeriod} orgId=${organizationId} userId=${userId}`)

        if (!organizationId || !planId || !billingPeriod || !userId) {
            return NextResponse.json({ error: 'Missing required fields', debug }, { status: 400 })
        }

        // STEP 1: Get user
        log('STEP 1: querying users table...')
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('email, full_name')
            .eq('user_id', userId)
            .single()
        log(`STEP 1 done: userData=${JSON.stringify(userData)} error=${JSON.stringify(userError)}`)

        if (userError || !userData) {
            return NextResponse.json({ error: 'User not found', debug }, { status: 404 })
        }

        // STEP 2: Get org
        log('STEP 2: querying organizations table...')
        const { data: orgData, error: orgError } = await supabase
            .from('organizations')
            .select('organization_id, name, stripe_customer_id, stripe_subscription_id, subscription_status')
            .eq('organization_id', organizationId)
            .single()
        log(`STEP 2 done: orgData=${JSON.stringify(orgData)} error=${JSON.stringify(orgError)}`)

        if (orgError || !orgData) {
            return NextResponse.json({ error: 'Organization not found', debug }, { status: 404 })
        }

        // STEP 3: Check active sub
        if (orgData.stripe_subscription_id &&
            orgData.subscription_status &&
            ['active', 'trialing', 'trial'].includes(orgData.subscription_status)) {
            log('STEP 3: has active subscription, aborting')
            return NextResponse.json({
                error: 'You already have an active subscription. Please use "Manage Billing" to change your plan.',
                hasActiveSubscription: true, debug
            }, { status: 400 })
        }
        log('STEP 3: no active subscription, proceeding')

        // STEP 4: Verify admin
        log('STEP 4: checking membership role...')
        const { data: memberData, error: memberError } = await supabase
            .from('organization_members')
            .select('role')
            .eq('organization_id', organizationId)
            .eq('user_id', userId)
            .single()
        log(`STEP 4 done: role=${memberData?.role} error=${JSON.stringify(memberError)}`)

        if (memberError || !memberData || !['owner', 'admin'].includes(memberData.role)) {
            return NextResponse.json({ error: 'Unauthorized: Only admins can manage billing', debug }, { status: 403 })
        }

        // STEP 5: Get/create Stripe customer
        let customerId = orgData.stripe_customer_id
        log(`STEP 5: stripe_customer_id from db=${customerId}`)
        log(`STEP 5: stripe client initialized=${!!stripe}`)
        log(`STEP 5: STRIPE_SECRET_KEY prefix=${process.env.STRIPE_SECRET_KEY?.substring(0, 15)}...`)

        if (!customerId) {
            log('STEP 5a: creating Stripe customer...')
            try {
                customerId = await getOrCreateStripeCustomer(
                    userData.email,
                    orgData.name,
                    { organization_id: organizationId.toString(), user_id: userId }
                )
                log(`STEP 5a done: customerId=${customerId}`)
            } catch (e) {
                log(`STEP 5a ERROR: ${e instanceof Error ? e.message : String(e)}`)
                return NextResponse.json({ error: 'Failed to create Stripe customer', debug }, { status: 500 })
            }

            await supabase
                .from('organizations')
                .update({ stripe_customer_id: customerId })
                .eq('organization_id', organizationId)
            log('STEP 5b: saved customer to org')
        }

        // STEP 6: Get price from DB
        log('STEP 6: querying subscription_plans for price ID...')
        const priceColumn = billingPeriod === 'yearly' ? 'stripe_price_id_yearly' : 'stripe_price_id_monthly'
        const { data: planData, error: planError } = await supabase
            .from('subscription_plans')
            .select(priceColumn)
            .eq('plan_id', planId)
            .single()

        const priceId = planData?.[priceColumn]
        log(`STEP 6 done: priceColumn=${priceColumn} priceId=${priceId} error=${JSON.stringify(planError)}`)

        if (planError || !priceId) {
            return NextResponse.json({ error: `Invalid plan or billing period: ${planId} ${billingPeriod}`, debug }, { status: 400 })
        }

        // STEP 7: Create checkout session
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.headers.get('origin') || ''
        log(`STEP 7: creating checkout session... customerId=${customerId} priceId=${priceId} baseUrl=${baseUrl}`)

        try {
            const session = await createCheckoutSession({
                customerId,
                priceId,
                organizationId,
                successUrl: `${baseUrl}/org/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
                cancelUrl: `${baseUrl}/org/billing?canceled=true`,
                trialDays: planId !== 'enterprise' ? 14 : undefined,
            })
            log(`STEP 7 done: sessionId=${session.id} url=${session.url}`)

            return NextResponse.json({ sessionId: session.id, url: session.url, debug })
        } catch (stripeError: unknown) {
            const errMsg = stripeError instanceof Error ? stripeError.message : String(stripeError)
            log(`STEP 7 ERROR: ${errMsg}`)

            if (stripeError instanceof Error && stripeError.message.includes('cannot combine currencies')) {
                log('STEP 7 retry: currency mismatch, creating new customer...')
                const newCustomerId = await createNewStripeCustomer(
                    userData.email, orgData.name,
                    { organization_id: organizationId, user_id: userId }
                )
                await supabase
                    .from('organizations')
                    .update({ stripe_customer_id: newCustomerId })
                    .eq('organization_id', organizationId)

                const session = await createCheckoutSession({
                    customerId: newCustomerId,
                    priceId,
                    organizationId,
                    successUrl: `${baseUrl}/org/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
                    cancelUrl: `${baseUrl}/org/billing?canceled=true`,
                    trialDays: planId !== 'enterprise' ? 14 : undefined,
                })
                log(`STEP 7 retry done: sessionId=${session.id}`)
                return NextResponse.json({ sessionId: session.id, url: session.url, debug })
            }
            throw stripeError
        }
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        log(`FATAL ERROR: ${errMsg}`)
        console.error('Checkout session error:', error)
        return NextResponse.json({ error: 'Failed to create checkout session', debug }, { status: 500 })
    }
}
