import { createRouter, createRoute, createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { getSession } from './lib/auth'
import AppLayout from './components/AppLayout'

import LoginPage from './pages/LoginPage'
import LoginCallbackPage from './pages/LoginCallbackPage'
import SignUpPage from './pages/SignUpPage'
import HomePage from './pages/HomePage'
import OrdersPage from './pages/OrdersPage'
import InventoryPage from './pages/InventoryPage'
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
  beforeLoad: () => {
    if (!getSession()) {
      throw redirect({ to: '/login' })
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
