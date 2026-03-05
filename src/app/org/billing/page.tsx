'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useOrganization } from '@/contexts/OrganizationContext'
import { supabase } from '@/lib/supabase-client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import {
    CreditCard,
    Check,
    ArrowLeft,
    Loader2,
    ExternalLink,
    AlertTriangle,
    CheckCircle,
    Receipt,
    Calendar
} from 'lucide-react'
import { Loading } from '@/components/ui/loading'
import { useToast } from '@/hooks/use-toast'
import { SUBSCRIPTION_PLANS, formatPrice } from '@/lib/stripe-client'
import { format } from 'date-fns'

interface BillingInfo {
    plan_name: string
    subscription_status: string | null
    current_period_end: string | null
    cancel_at_period_end: boolean
    stripe_subscription_id: string | null
    stripe_customer_id: string | null
}

interface BillingHistoryItem {
    billing_id: number
    amount_paid: number
    currency: string
    status: string
    description: string
    invoice_url: string | null
    created_at: string
}

function BillingContent() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const { user, loading: authLoading } = useAuth()
    const { currentOrganization, isLoadingOrgs, isAdmin, refreshOrganizations } = useOrganization()
    const { toast } = useToast()

    const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null)
    const [billingHistory, setBillingHistory] = useState<BillingHistoryItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isProcessing, setIsProcessing] = useState(false)
    const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
    const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly')
    const [debugLogs, setDebugLogs] = useState<string[]>([])

    const addLog = (msg: string) => {
        const entry = `[${new Date().toISOString()}] ${msg}`
        setDebugLogs(prev => [...prev, entry])
        console.log(entry)
    }

    // Check for success/cancel from Stripe checkout
    useEffect(() => {
        const success = searchParams.get('success')
        const canceled = searchParams.get('canceled')

        if (success === 'true') {
            toast({
                title: "Success!",
                description: "Your subscription has been activated.",
            })
            // Refresh organization data to show updated subscription
            refreshOrganizations()
            // Clear URL params
            router.replace('/org/billing')
        } else if (canceled === 'true') {
            toast({
                title: "Checkout Canceled",
                description: "Your subscription was not changed.",
                variant: "destructive",
            })
            router.replace('/org/billing')
        }
    }, [searchParams, router, toast, refreshOrganizations])

    useEffect(() => {
        if (!authLoading && !user) {
            router.push('/login')
        }
    }, [user, authLoading, router])

    useEffect(() => {
        if (!isLoadingOrgs && user && !currentOrganization) {
            router.push('/org/select')
        }
    }, [user, isLoadingOrgs, currentOrganization, router])

    useEffect(() => {
        if (!isLoadingOrgs && currentOrganization && !isAdmin) {
            router.push('/dashboard')
            toast({
                title: "Access Denied",
                description: "Only administrators can manage billing",
                variant: "destructive",
            })
        }
    }, [isLoadingOrgs, currentOrganization, isAdmin, router, toast])

    useEffect(() => {
        const fetchBillingInfo = async () => {
            if (!currentOrganization) return

            try {
                // Get organization billing info
                const { data: orgData, error: orgError } = await supabase
                    .from('organizations')
                    .select(`
                        subscription_status,
                        current_period_end,
                        cancel_at_period_end,
                        stripe_subscription_id,
                        stripe_customer_id,
                        subscription_plans (
                            name
                        )
                    `)
                    .eq('organization_id', currentOrganization.organization_id)
                    .single()

                if (orgError) throw orgError

                setBillingInfo({
                    plan_name: (orgData.subscription_plans as { name: string })?.name || 'Free',
                    subscription_status: orgData.subscription_status,
                    current_period_end: orgData.current_period_end,
                    cancel_at_period_end: orgData.cancel_at_period_end,
                    stripe_subscription_id: orgData.stripe_subscription_id,
                    stripe_customer_id: orgData.stripe_customer_id,
                })

                // Get billing history
                const { data: historyData } = await supabase
                    .from('billing_history')
                    .select('*')
                    .eq('organization_id', currentOrganization.organization_id)
                    .order('created_at', { ascending: false })
                    .limit(10)

                setBillingHistory(historyData || [])
            } catch (err) {
                console.error('Error fetching billing info:', err)
            } finally {
                setIsLoading(false)
            }
        }

        // Only fetch if organization is loaded and we've determined admin status
        if (!isLoadingOrgs && currentOrganization) {
            if (isAdmin) {
                fetchBillingInfo()
            } else {
                // Not admin - stop loading to allow redirect
                setIsLoading(false)
            }
        }
    }, [currentOrganization, isAdmin, isLoadingOrgs])

    const handleSubscribe = async (planId: string) => {
        addLog(`handleSubscribe called: planId=${planId}, billingPeriod=${billingPeriod}`)
        addLog(`user=${user?.id}, org=${currentOrganization?.organization_id}`)

        if (!user || !currentOrganization) {
            addLog('ABORT: user or currentOrganization is null')
            return
        }

        if (planId === 'free') {
            addLog('ABORT: free plan selected')
            toast({ title: "Free Plan", description: "You're already on the free plan." })
            return
        }

        setIsProcessing(true)
        setSelectedPlan(planId)

        const reqBody = {
            organizationId: currentOrganization.organization_id,
            planId,
            billingPeriod,
            userId: user.id,
        }
        addLog(`POST /api/stripe/checkout body=${JSON.stringify(reqBody)}`)

        try {
            const response = await fetch('/api/stripe/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody),
            })

            addLog(`Response status=${response.status} ok=${response.ok}`)
            const data = await response.json()
            addLog(`Response data=${JSON.stringify(data)}`)

            if (!response.ok) {
                throw new Error(data.error || 'Failed to create checkout session')
            }

            if (data.url) {
                addLog(`Redirecting to: ${data.url}`)
                window.location.href = data.url
            } else {
                addLog('ERROR: No url in response data')
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            addLog(`CATCH error: ${errMsg}`)
            toast({
                title: "Error",
                description: errMsg,
                variant: "destructive",
            })
        } finally {
            setIsProcessing(false)
            setSelectedPlan(null)
        }
    }

    const handleManageBilling = async () => {
        if (!user || !currentOrganization) return

        setIsProcessing(true)

        try {
            const response = await fetch('/api/stripe/portal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    organizationId: currentOrganization.organization_id,
                    userId: user.id,
                }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Failed to open billing portal')
            }

            // Redirect to Stripe Billing Portal
            if (data.url) {
                window.location.href = data.url
            }
        } catch (err) {
            console.error('Portal error:', err)
            toast({
                title: "Error",
                description: err instanceof Error ? err.message : "Failed to open billing portal",
                variant: "destructive",
            })
        } finally {
            setIsProcessing(false)
        }
    }

    if (authLoading || isLoadingOrgs || isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loading size="lg" />
            </div>
        )
    }

    if (!user || !currentOrganization || !isAdmin) {
        return null
    }

    const currentPlan = SUBSCRIPTION_PLANS.find(p => p.name.toLowerCase() === billingInfo?.plan_name.toLowerCase())

    return (
        <div className="max-w-6xl mx-auto py-8 px-4">
            <Button
                variant="ghost"
                onClick={() => router.push('/org/settings')}
                className="mb-6"
            >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Settings
            </Button>

            <div className="mb-8">
                <h1 className="text-3xl font-bold">Billing & Subscription</h1>
                <p className="text-muted-foreground mt-1">
                    Manage your organization&apos;s subscription plan
                </p>
            </div>

            {/* Current Plan Status */}
            <Card className="mb-8">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <CreditCard className="h-5 w-5" />
                        Current Plan
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-2xl font-bold">{billingInfo?.plan_name || 'Free'}</h3>
                            {billingInfo?.subscription_status && (
                                <div className="flex items-center gap-2 mt-2">
                                    <Badge variant={
                                        billingInfo.subscription_status === 'active' ? 'default' :
                                        billingInfo.subscription_status === 'trialing' ? 'secondary' :
                                        'destructive'
                                    }>
                                        {billingInfo.subscription_status}
                                    </Badge>
                                    {billingInfo.cancel_at_period_end && (
                                        <Badge variant="outline">Cancels at period end</Badge>
                                    )}
                                </div>
                            )}
                            {billingInfo?.current_period_end && (
                                <p className="text-sm text-muted-foreground mt-2">
                                    <Calendar className="inline h-4 w-4 mr-1" />
                                    {billingInfo.cancel_at_period_end ? 'Access until' : 'Renews'}: {format(new Date(billingInfo.current_period_end), 'MMMM d, yyyy')}
                                </p>
                            )}
                        </div>
                        {billingInfo?.stripe_customer_id && (
                            <Button onClick={handleManageBilling} disabled={isProcessing}>
                                {isProcessing ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                )}
                                Manage Billing
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Billing Period Toggle */}
            <div className="flex justify-center mb-8">
                <div className="inline-flex items-center rounded-lg border p-1">
                    <Button
                        variant={billingPeriod === 'monthly' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setBillingPeriod('monthly')}
                    >
                        Monthly
                    </Button>
                    <Button
                        variant={billingPeriod === 'yearly' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setBillingPeriod('yearly')}
                    >
                        Yearly
                        <Badge variant="secondary" className="ml-2">Save 17%</Badge>
                    </Button>
                </div>
            </div>

            {/* Plan Cards */}
            {/* Show info banner if user has active subscription */}
            {billingInfo?.stripe_subscription_id && billingInfo?.subscription_status &&
                ['active', 'trialing', 'trial'].includes(billingInfo.subscription_status) && (
                <Alert className="mb-6">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        You have an active subscription. To change your plan, please use the <strong>Manage Billing</strong> button above.
                    </AlertDescription>
                </Alert>
            )}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 mb-8">
                {SUBSCRIPTION_PLANS.map((plan) => {
                    const isCurrentPlan = currentPlan?.id === plan.id
                    const price = billingPeriod === 'monthly' ? plan.price.monthly : plan.price.yearly
                    const hasActiveSubscription = billingInfo?.stripe_subscription_id &&
                        billingInfo?.subscription_status &&
                        ['active', 'trialing', 'trial'].includes(billingInfo.subscription_status)

                    return (
                        <Card
                            key={plan.id}
                            className={`relative ${plan.highlighted ? 'border-primary shadow-lg' : ''} ${isCurrentPlan ? 'bg-muted/50' : ''}`}
                        >
                            {plan.highlighted && (
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                                    <Badge>Most Popular</Badge>
                                </div>
                            )}
                            <CardHeader>
                                <CardTitle>{plan.name}</CardTitle>
                                <CardDescription>{plan.description}</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="mb-4">
                                    <span className="text-3xl font-bold">{formatPrice(price)}</span>
                                    {price > 0 && (
                                        <span className="text-muted-foreground">
                                            /{billingPeriod === 'monthly' ? 'mo' : 'yr'}
                                        </span>
                                    )}
                                </div>
                                <ul className="space-y-2 mb-6">
                                    {plan.features.map((feature, index) => (
                                        <li key={index} className="flex items-start gap-2 text-sm">
                                            <Check className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                                            <span>{feature}</span>
                                        </li>
                                    ))}
                                </ul>
                                <Button
                                    className="w-full"
                                    variant={isCurrentPlan ? 'outline' : plan.highlighted ? 'default' : 'secondary'}
                                    disabled={isCurrentPlan || isProcessing || (hasActiveSubscription && !isCurrentPlan)}
                                    onClick={() => hasActiveSubscription ? handleManageBilling() : handleSubscribe(plan.id)}
                                >
                                    {isProcessing && selectedPlan === plan.id ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : isCurrentPlan ? (
                                        'Current Plan'
                                    ) : hasActiveSubscription ? (
                                        'Use Manage Billing'
                                    ) : plan.id === 'free' ? (
                                        'Downgrade'
                                    ) : (
                                        'Subscribe'
                                    )}
                                </Button>
                            </CardContent>
                        </Card>
                    )
                })}
            </div>

            <Separator className="my-8" />

            {/* Billing History */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Receipt className="h-5 w-5" />
                        Billing History
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {billingHistory.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                            No billing history yet
                        </p>
                    ) : (
                        <div className="space-y-4">
                            {billingHistory.map((item) => (
                                <div
                                    key={item.billing_id}
                                    className="flex items-center justify-between py-3 border-b last:border-0"
                                >
                                    <div>
                                        <p className="font-medium">{item.description}</p>
                                        <p className="text-sm text-muted-foreground">
                                            {format(new Date(item.created_at), 'MMMM d, yyyy')}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="text-right">
                                            <p className="font-medium">
                                                {formatPrice(item.amount_paid / 100, item.currency.toUpperCase())}
                                            </p>
                                            <Badge variant={item.status === 'paid' ? 'default' : 'destructive'}>
                                                {item.status}
                                            </Badge>
                                        </div>
                                        {item.invoice_url && (
                                            <Button variant="ghost" size="sm" asChild>
                                                <a href={item.invoice_url} target="_blank" rel="noopener noreferrer">
                                                    <ExternalLink className="h-4 w-4" />
                                                </a>
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* DEBUG PANEL - Remove after debugging */}
            {debugLogs.length > 0 && (
                <Card className="mt-8 border-red-500">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-red-500 flex items-center justify-between">
                            <span>Debug Logs</span>
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        navigator.clipboard.writeText(debugLogs.join('\n'))
                                        toast({ title: 'Copied!', description: 'Logs copied to clipboard' })
                                    }}
                                >
                                    Copy All Logs
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setDebugLogs([])}
                                >
                                    Clear
                                </Button>
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-xs bg-black text-green-400 p-4 rounded overflow-auto max-h-80 whitespace-pre-wrap">
                            {debugLogs.join('\n')}
                        </pre>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

export default function BillingPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loading size="lg" />
            </div>
        }>
            <BillingContent />
        </Suspense>
    )
}
