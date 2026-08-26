import { createRouter, createRoute, createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { getSession } from './lib/auth'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import QueuePage from './pages/QueuePage'
import OverviewPage from './pages/OverviewPage'
import PipelinePage from './pages/PipelinePage'
import ProspectsPage from './pages/ProspectsPage'
import MerchantsPage from './pages/MerchantsPage'
import TeamPage from './pages/TeamPage'
import NewProspectPage from './pages/NewProspectPage'
import ProspectDetailPage from './pages/ProspectDetailPage'

const rootRoute = createRootRoute({ component: () => <Outlet /> })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: () => {
    if (getSession()) throw redirect({ to: '/queue' })
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

// The landing page. "Here are the merchants who need you today" is the whole
// point of the tool; a numbers dashboard is what you look at afterwards.
const queueRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/queue',
  component: QueuePage,
})

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/overview',
  component: OverviewPage,
})

const pipelineRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pipeline',
  component: PipelinePage,
})

const merchantsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/merchants',
  component: MerchantsPage,
})

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  beforeLoad: () => {
    // Hiding the tab is not enough — the URL is still typeable. Presentation
    // only; /staff/team refuses a member regardless of what this decides.
    const session = getSession()
    if (session && session.user.role === 'member') throw redirect({ to: '/queue' })
  },
  component: TeamPage,
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
    throw redirect({ to: getSession() ? '/queue' : '/login' })
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  changePasswordRoute,
  appRoute.addChildren([
    queueRoute,
    overviewRoute,
    pipelineRoute,
    merchantsRoute,
    teamRoute,
    prospectsRoute,
    newProspectRoute,
    prospectDetailRoute,
  ]),
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
