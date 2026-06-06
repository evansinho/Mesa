import { createRouter, createRoute, createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { getSession } from './lib/auth'
import { apiFetch } from './lib/api'
import AppLayout from './components/AppLayout'

import LoginPage from './pages/LoginPage'
import LoginCallbackPage from './pages/LoginCallbackPage'
import SignUpPage from './pages/SignUpPage'
import HomePage from './pages/HomePage'
import OrdersPage from './pages/OrdersPage'
import InventoryPage from './pages/InventoryPage'
import CustomersPage from './pages/CustomersPage'
import SettingsPage from './pages/SettingsPage'
import BillingPage from './pages/BillingPage'
import WhatsAppPage from './pages/onboarding/WhatsAppPage'
import WhatsAppCallbackPage from './pages/onboarding/WhatsAppCallbackPage'
import InstagramCallbackPage from './pages/onboarding/InstagramCallbackPage'
import MonoPage from './pages/onboarding/MonoPage'

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
})

const loginCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/callback',
  validateSearch: (search: Record<string, unknown>) => ({ token: (search.token as string) ?? '' }),
  component: LoginCallbackPage,
})

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  component: SignUpPage,
})

const authLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  beforeLoad: async ({ location }) => {
    const session = getSession()
    if (!session) throw redirect({ to: '/login' })

    const onOnboarding = location.pathname.startsWith('/onboarding')
    if (onOnboarding) return

    const res = await apiFetch(`/merchants/${session.merchantId}`)
    if (res.ok) {
      const data = await res.json() as { merchant: { channels: { channel: string }[] } }
      const hasWhatsApp = data.merchant.channels.some(c => c.channel === 'whatsapp')
      if (!hasWhatsApp) throw redirect({ to: '/onboarding/whatsapp' })
    }
  },
  component: AppLayout,
})

const homeRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/',
  component: HomePage,
})

const ordersRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/orders',
  component: OrdersPage,
})

const inventoryRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/inventory',
  component: InventoryPage,
})

const customersRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/customers',
  component: CustomersPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/settings',
  component: SettingsPage,
})

const billingRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/billing',
  component: BillingPage,
})

const whatsAppOnboardingRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/onboarding/whatsapp',
  component: WhatsAppPage,
})

const whatsAppCallbackRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/onboarding/whatsapp/callback',
  component: WhatsAppCallbackPage,
})

const instagramCallbackRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/onboarding/instagram/callback',
  component: InstagramCallbackPage,
})

const monoRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/onboarding/mono',
  component: MonoPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  loginCallbackRoute,
  signUpRoute,
  authLayoutRoute.addChildren([
    homeRoute,
    ordersRoute,
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
