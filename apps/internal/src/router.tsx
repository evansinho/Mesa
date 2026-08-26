import { createRouter, createRoute, createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { getSession } from './lib/auth'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import OverviewPage from './pages/OverviewPage'
import ProspectsPage from './pages/ProspectsPage'
import NewProspectPage from './pages/NewProspectPage'
import ProspectDetailPage from './pages/ProspectDetailPage'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: () => {
    if (getSession()) throw redirect({ to: '/overview' })
  },
  component: LoginPage,
})

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/change-password',
  beforeLoad: () => {
    if (!getSession()) throw redirect({ to: '/login' })
  },
  component: ChangePasswordPage,
})

// Authenticated shell. The session check here is a routing convenience only —
// it decides what to render, never what the caller is allowed to read. Every
// /staff/* endpoint re-authenticates and re-authorizes server-side, because
// this check reads localStorage and localStorage is editable.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: () => {
    const session = getSession()
    if (!session) throw redirect({ to: '/login' })
    // A temporary password is a hard gate: nothing else is reachable until
    // it's replaced.
    if (session.user.mustResetPassword) throw redirect({ to: '/change-password' })
  },
  component: AppShell,
})

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/overview',
  component: OverviewPage,
})

const prospectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/prospects',
  component: ProspectsPage,
})

const newProspectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/prospects/new',
  component: NewProspectPage,
})

const prospectDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/prospects/$id',
  component: ProspectDetailPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: getSession() ? '/overview' : '/login' })
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  changePasswordRoute,
  appRoute.addChildren([overviewRoute, prospectsRoute, newProspectRoute, prospectDetailRoute]),
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
