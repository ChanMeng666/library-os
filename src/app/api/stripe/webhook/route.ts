import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { stripe, constructWebhookEvent } from '@/lib/stripe-server'
import { sendSubscriptionEmail } from '@/lib/resend'

// Create Supabase client with service role for server operations
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Webhook secret from Stripe Dashboard
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

export async function POST(request: NextRequest) {
    try {
        const body = await request.text()
        const signature = request.headers.get('stripe-signature')

        if (!signature) {
            return NextResponse.json(
                { error: 'Missing stripe-signature header' },
                { status: 400 }
            )
        }

        let event: Stripe.Event

        try {
            event = await constructWebhookEvent(body, signature, webhookSecret)
        } catch (err) {
            console.error('Webhook signature verification failed:', err)
            return NextResponse.json(
                { error: 'Invalid signature' },
                { status: 400 }
            )
        }

        // Library Management System Price IDs (to filter events for this project only)
        // Live Mode Price IDs
        const LIVE_PRICE_IDS = [
            'price_1SjyGc86MNjhkH0a6Jv7jH5r', // Basic monthly $0.99
            'price_1SjyGf86MNjhkH0aOzA6kwVT', // Basic yearly $9.99
            'price_1SjyGj86MNjhkH0aRd13R01S', // Pro monthly $2.99
            'price_1SjyGm86MNjhkH0agZWkyvAB', // Pro yearly $29.99
            'price_1SjyGo86MNjhkH0aSJ6j7tpa', // Enterprise monthly $8.99
            'price_1SjyGs86MNjhkH0aoAD8RwqP', // Enterprise yearly $89.99
        ]
        // Test Mode Price IDs
        const TEST_PRICE_IDS = [
            'price_1Sjvyj86MNjhkH0aYaxu1M8A', // Basic monthly
            'price_1Sjvyj86MNjhkH0afkLmyIe6', // Basic yearly
            'price_1Sjvyl86MNjhkH0aJSPO6Zkl', // Pro monthly
            'price_1Sjvyl86MNjhkH0a9F1rmQzo', // Pro yearly
            'price_1Sjvyn86MNjhkH0aKIvNQwrA', // Enterprise monthly
            'price_1Sjvyn86MNjhkH0ailX8YoXK', // Enterprise yearly
        ]
        const VALID_PRICE_IDS = [...LIVE_PRICE_IDS, ...TEST_PRICE_IDS]

        // Helper to check if event is for this project
        const isOurProduct = (priceId: string | undefined) => {
            return priceId && VALID_PRICE_IDS.some(id => priceId.includes(id.slice(-8)))
        }

        // Handle the event
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session
                // Only process if metadata indicates it's from our app
                if (session.metadata?.organization_id) {
                    await handleCheckoutCompleted(session)
                } else {
                    console.log('Skipping checkout.session.completed - not from Library Management System')
                }
                break
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const subscription = event.data.object as Stripe.Subscription
                const priceId = subscription.items.data[0]?.price.id
                if (isOurProduct(priceId)) {
                    await handleSubscriptionUpdated(subscription)
                } else {
                    console.log(`Skipping subscription event - price ${priceId} not from Library Management System`)
                }
                break
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object as Stripe.Subscription
                const priceId = subscription.items.data[0]?.price.id
                if (isOurProduct(priceId)) {
                    await handleSubscriptionDeleted(subscription)
                } else {
                    console.log(`Skipping subscription.deleted - price ${priceId} not from Library Management System`)
                }
                break
            }

            case 'invoice.paid': {
                const invoice = event.data.object as Stripe.Invoice
                const priceId = invoice.lines.data[0]?.price?.id
                if (isOurProduct(priceId)) {
                    await handleInvoicePaid(invoice)
                } else {
                    console.log(`Skipping invoice.paid - not from Library Management System`)
                }
                break
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object as Stripe.Invoice
                const priceId = invoice.lines.data[0]?.price?.id
                if (isOurProduct(priceId)) {
                    await handleInvoicePaymentFailed(invoice)
                } else {
                    console.log(`Skipping invoice.payment_failed - not from Library Management System`)
                }
                break
            }

            default:
                console.log(`Unhandled event type: ${event.type}`)
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('Webhook error:', error)
        return NextResponse.json(
            { error: 'Webhook handler failed' },
            { status: 500 }
        )
    }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const organizationId = session.metadata?.organization_id
    const customerId = session.customer as string
    const subscriptionId = session.subscription as string

    if (!organizationId) {
        console.error('No organization_id in session metadata')
        return
    }

    // Fetch subscription details from Stripe
    let subscriptionPlan = 'free'
    let subscriptionStatus = 'active'
    let priceId = ''
    let currentPeriodEnd: string | null = null

    if (stripe && subscriptionId) {
        try {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId)
            priceId = subscription.items.data[0]?.price.id || ''

            // Determine plan from price_id
            if (priceId.includes('Sjvyj')) subscriptionPlan = 'basic'
            else if (priceId.includes('Sjvyl')) subscriptionPlan = 'pro'
            else if (priceId.includes('Sjvyn')) subscriptionPlan = 'enterprise'

            // Map status
            if (subscription.status === 'trialing') subscriptionStatus = 'trial'
            else if (subscription.status === 'active') subscriptionStatus = 'active'

            if (subscription.current_period_end) {
                currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString()
            }
        } catch (err) {
            console.error('Error fetching subscription:', err)
        }
    }

    // Update organization with subscription details
    const updateData: Record<string, unknown> = {
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_price_id: priceId,
        subscription_plan: subscriptionPlan,
        subscription_status: subscriptionStatus,
    }

    if (currentPeriodEnd) {
        updateData.current_period_end = currentPeriodEnd
    }

    // Get current organization state before update
    const { data: currentOrg } = await supabase
        .from('organizations')
        .select('subscription_plan, subscription_status')
        .eq('organization_id', organizationId)
        .single()

    await supabase
        .from('organizations')
        .update(updateData)
        .eq('organization_id', organizationId)

    // Record subscription history
    await supabase
        .from('subscription_history')
        .insert({
            organization_id: organizationId,
            previous_plan: currentOrg?.subscription_plan || 'free',
            new_plan: subscriptionPlan,
            previous_status: currentOrg?.subscription_status || 'trial',
            new_status: subscriptionStatus,
            stripe_invoice_id: subscriptionId,
            change_reason: 'Subscription created via Stripe checkout',
        })

    // Get organization details for email
    const { data: orgData } = await supabase
        .from('organizations')
        .select(`
            name,
            organization_members!inner (
                users!inner (
                    email,
                    full_name
                )
            )
        `)
        .eq('organization_id', organizationId)
        .eq('organization_members.role', 'owner')
        .single()

    if (orgData) {
        const ownerEmail = (orgData.organization_members as { users: { email: string } }[])[0]?.users?.email
        const ownerName = (orgData.organization_members as { users: { full_name: string } }[])[0]?.users?.full_name

        if (ownerEmail) {
            await sendSubscriptionEmail({
                to: ownerEmail,
                type: 'subscription_created',
                data: {
                    organizationName: orgData.name,
                    userName: ownerName || 'there',
                },
            })
        }
    }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
    const customerId = subscription.customer as string

    // Find organization by customer ID with current state
    const { data: orgData, error } = await supabase
        .from('organizations')
        .select('organization_id, subscription_plan, subscription_status')
        .eq('stripe_customer_id', customerId)
        .single()

    if (error || !orgData) {
        console.error('Organization not found for customer:', customerId)
        return
    }

    const previousPlan = orgData.subscription_plan
    const previousStatus = orgData.subscription_status

    const priceId = subscription.items.data[0]?.price.id

    // Map Stripe status to DB constraint values: 'trial', 'active', 'past_due', 'suspended', 'cancelled'
    let status = 'active'
    if (subscription.status === 'trialing') status = 'trial'
    else if (subscription.status === 'active') status = 'active'
    else if (subscription.status === 'past_due') status = 'past_due'
    else if (subscription.status === 'canceled') status = 'cancelled'

    const currentPeriodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null
    const cancelAtPeriodEnd = subscription.cancel_at_period_end

    // Determine plan from price_id
    let plan = 'free'
    if (priceId?.includes('Sjvyj')) plan = 'basic'
    else if (priceId?.includes('Sjvyl')) plan = 'pro'
    else if (priceId?.includes('Sjvyn')) plan = 'enterprise'

    // Update organization directly (more reliable than RPC)
    const updateData: Record<string, unknown> = {
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        subscription_plan: plan,
        subscription_status: status,
        cancel_at_period_end: cancelAtPeriodEnd,
    }

    if (currentPeriodEnd) {
        updateData.current_period_end = currentPeriodEnd.toISOString()
    }

    await supabase
        .from('organizations')
        .update(updateData)
        .eq('organization_id', orgData.organization_id)

    // Record subscription history if plan or status changed
    if (previousPlan !== plan || previousStatus !== status) {
        await supabase
            .from('subscription_history')
            .insert({
                organization_id: orgData.organization_id,
                previous_plan: previousPlan || 'free',
                new_plan: plan,
                previous_status: previousStatus || 'trial',
                new_status: status,
                change_reason: cancelAtPeriodEnd
                    ? 'Subscription scheduled for cancellation'
                    : 'Subscription updated',
            })
    }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const customerId = subscription.customer as string

    // Find organization by customer ID
    const { data: orgData } = await supabase
        .from('organizations')
        .select('organization_id, name, subscription_plan')
        .eq('stripe_customer_id', customerId)
        .single()

    if (!orgData) {
        console.error('Organization not found for customer:', customerId)
        return
    }

    const previousPlan = orgData.subscription_plan

    // Reset to free plan
    await supabase
        .from('organizations')
        .update({
            stripe_subscription_id: null,
            stripe_price_id: null,
            subscription_status: 'canceled',
            subscription_plan: 'free',
        })
        .eq('organization_id', orgData.organization_id)

    // Record in subscription history
    await supabase
        .from('subscription_history')
        .insert({
            organization_id: orgData.organization_id,
            previous_plan: previousPlan,
            new_plan: 'free',
            previous_status: 'active',
            new_status: 'canceled',
            change_reason: 'Subscription canceled',
        })
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string

    // Find organization by customer ID
    const { data: orgData } = await supabase
        .from('organizations')
        .select('organization_id')
        .eq('stripe_customer_id', customerId)
        .single()

    if (!orgData) {
        return
    }

    // Record billing history
    await supabase.from('billing_history').insert({
        organization_id: orgData.organization_id,
        stripe_invoice_id: invoice.id,
        stripe_payment_intent_id: invoice.payment_intent as string,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        status: 'paid',
        description: invoice.lines.data[0]?.description || 'Subscription payment',
        invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
    })
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string

    // Find organization by customer ID
    const { data: orgData } = await supabase
        .from('organizations')
        .select(`
            organization_id,
            name,
            organization_members!inner (
                users!inner (
                    email,
                    full_name
                )
            )
        `)
        .eq('stripe_customer_id', customerId)
        .eq('organization_members.role', 'owner')
        .single()

    if (!orgData) {
        return
    }

    // Record failed payment
    await supabase.from('billing_history').insert({
        organization_id: orgData.organization_id,
        stripe_invoice_id: invoice.id,
        amount_paid: invoice.amount_due,
        currency: invoice.currency,
        status: 'failed',
        description: 'Payment failed',
        invoice_url: invoice.hosted_invoice_url,
    })

    // Send payment failed email
    const ownerEmail = (orgData.organization_members as { users: { email: string } }[])[0]?.users?.email
    const ownerName = (orgData.organization_members as { users: { full_name: string } }[])[0]?.users?.full_name

    if (ownerEmail) {
        await sendSubscriptionEmail({
            to: ownerEmail,
            type: 'payment_failed',
            data: {
                organizationName: orgData.name,
                userName: ownerName || 'there',
                invoiceUrl: invoice.hosted_invoice_url || '',
            },
        })
    }
}
