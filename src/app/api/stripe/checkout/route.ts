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
    try {
        const body = await request.json()
        const { organizationId, planId, billingPeriod, userId } = body

        if (!organizationId || !planId || !billingPeriod || !userId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
        }

        // Get user
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('email, full_name')
            .eq('user_id', userId)
            .single()

        if (userError || !userData) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        // Get organization
        const { data: orgData, error: orgError } = await supabase
            .from('organizations')
            .select('organization_id, name, stripe_customer_id, stripe_subscription_id, subscription_status')
            .eq('organization_id', organizationId)
            .single()

        if (orgError || !orgData) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
        }

        // Check for active subscription
        if (orgData.stripe_subscription_id &&
            orgData.subscription_status &&
            ['active', 'trialing', 'trial'].includes(orgData.subscription_status)) {
            return NextResponse.json({
                error: 'You already have an active subscription. Please use "Manage Billing" to change your plan.',
                hasActiveSubscription: true
            }, { status: 400 })
        }

        // Verify admin role
        const { data: memberData, error: memberError } = await supabase
            .from('organization_members')
            .select('role')
            .eq('organization_id', organizationId)
            .eq('user_id', userId)
            .single()

        if (memberError || !memberData || !['owner', 'admin'].includes(memberData.role)) {
            return NextResponse.json({ error: 'Unauthorized: Only admins can manage billing' }, { status: 403 })
        }

        // Get or create Stripe customer
        let customerId = orgData.stripe_customer_id

        if (!customerId) {
            customerId = await getOrCreateStripeCustomer(
                userData.email,
                orgData.name,
                { organization_id: organizationId.toString(), user_id: userId }
            )

            await supabase
                .from('organizations')
                .update({ stripe_customer_id: customerId })
                .eq('organization_id', organizationId)
        }

        // Get price ID from database
        const priceColumn = billingPeriod === 'yearly' ? 'stripe_price_id_yearly' : 'stripe_price_id_monthly'
        const { data: planData, error: planError } = await supabase
            .from('subscription_plans')
            .select(priceColumn)
            .eq('plan_id', planId)
            .single()

        const priceId = planData?.[priceColumn]

        if (planError || !priceId) {
            return NextResponse.json({ error: `Invalid plan or billing period: ${planId} ${billingPeriod}` }, { status: 400 })
        }

        // Create checkout session
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.headers.get('origin') || ''

        try {
            const session = await createCheckoutSession({
                customerId,
                priceId,
                organizationId,
                successUrl: `${baseUrl}/org/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
                cancelUrl: `${baseUrl}/org/billing?canceled=true`,
                trialDays: planId !== 'enterprise' ? 14 : undefined,
            })

            return NextResponse.json({ sessionId: session.id, url: session.url })
        } catch (stripeError: unknown) {
            // Handle currency mismatch by creating a new customer
            if (stripeError instanceof Error && stripeError.message.includes('cannot combine currencies')) {
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
                return NextResponse.json({ sessionId: session.id, url: session.url })
            }
            throw stripeError
        }
    } catch (error) {
        console.error('Checkout session error:', error)
        return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
    }
}
