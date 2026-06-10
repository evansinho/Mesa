import { createRouter, createRoute, createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { getSession } from './lib/auth'
import { apiFetch } from './lib/api'
import AppLayout from './components/AppLayout'

import AuthPage from './pages/AuthPage'
import LoginCallbackPage from './pages/LoginCallbackPage'
import HomePage from './pages/HomePage'
import OrdersPage from './pages/OrdersPage'
import MoneyPage from './pages/MoneyPage'
import InsightsPage from './pages/InsightsPage'
import MorePage from './pages/MorePage'
import InventoryPage from './pages/InventoryPage'
import CustomersPage from './pages/CustomersPage'
import SettingsPage from './pages/SettingsPage'
import BillingPage from './pages/BillingPage'
import WhatsAppPage from './pages/onboarding/WhatsAppPage'
import WhatsAppCallbackPage from './pages/onboarding/WhatsAppCallbackPage'
import InstagramCallbackPage from './pages/onboarding/InstagramCallbackPage'
import MonoPage from './pages/onboarding/MonoPage'
import OnboardingSetupPage from './pages/onboarding/SetupPage'
import ActionOrderPage from './pages/actions/ActionOrderPage'
import ActionPaymentPage from './pages/actions/ActionPaymentPage'

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: AuthPage,
})

const loginCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/callback',
  validateSearch: (search: Record<string, unknown>) => ({ token: (search.token as string) ?? '' }),
  component: LoginCallbackPage,
})

// Redirect /sign-up → /login
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: () => { throw redirect({ to: '/login' }) },
  component: () => null,
})

const authLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  beforeLoad: async ({ location }) => {
    const session = getSession()
    if (!session) throw redirect({ to: '/login' })

    const onOnboarding = location.pathname.startsWith('/onboarding')
    const onActions = location.pathname.startsWith('/actions')
    if (onOnboarding || onActions) return

    const res = await apiFetch(`/merchants/${session.merchantId}`)
    if (res.ok) {
      const data = await res.json() as { merchant: { config?: { onboarding?: { status?: string } } } }
      const onboardingStatus = data.merchant.config?.onboarding?.status
      if (!onboardingStatus || onboardingStatus !== 'complete') {
        throw redirect({ to: '/onboarding/setup' })
      }
    }
  },
  component: AppLayout,
})

const homeRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/', component: HomePage })
const ordersRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/orders', component: OrdersPage })
const moneyRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/money', component: MoneyPage })
const insightsRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/insights', component: InsightsPage })
const moreRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/more', component: MorePage })
const inventoryRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/inventory', component: InventoryPage })
const customersRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/customers', component: CustomersPage })
const settingsRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/settings', component: SettingsPage })
const billingRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/billing', component: BillingPage })

const whatsAppOnboardingRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/onboarding/whatsapp', component: WhatsAppPage })
const whatsAppCallbackRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/onboarding/whatsapp/callback', component: WhatsAppCallbackPage })
const instagramCallbackRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/onboarding/instagram/callback', component: InstagramCallbackPage })
const monoRoute = createRoute({ getParentRoute: () => authLayoutRoute, path: '/onboarding/mono', component: MonoPage })

const onboardingSetupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/onboarding/setup', component: OnboardingSetupPage })
const actionOrderRoute = createRoute({ getParentRoute: () => rootRoute, path: '/actions/order/$token', component: ActionOrderPage })
const actionPaymentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/actions/payment/$token', component: ActionPaymentPage })

const routeTree = rootRoute.addChildren([
  loginRoute,
  loginCallbackRoute,
  signUpRoute,
  onboardingSetupRoute,
  actionOrderRoute,
  actionPaymentRoute,
  authLayoutRoute.addChildren([
    homeRoute,
    ordersRoute,
    moneyRoute,
    insightsRoute,
    moreRoute,
    inventoryRoute,
    customersRoute,
    settingsRoute,
    billingRoute,
    whatsAppOnboardingRoute,
    whatsAppCallbackRoute,
    instagramCallbackRoute,
    monoRoute,
  ]),
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
