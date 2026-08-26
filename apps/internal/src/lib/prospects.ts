import { useQuery } from '@tanstack/react-query'
import { api, type Paged, type Prospect } from './api'

/**
 * The prospect list, fetched through ONE hook.
 *
 * Same reasoning as useDashboard: two pages read this endpoint under the key
 * ['prospects'], one returning the full paged envelope and the other just the
 * rows. They share a cache entry, so whichever resolved first decided what the
 * other received, and the loser got a shape it could not iterate.
 *
 * The rule this encodes: a query key owns a shape. If two callers need
 * different shapes they need different keys or a `select`, never a different
 * queryFn under the same key.
 */
export const PROSPECTS_KEY = ['prospects'] as const

export function useProspects() {
  return useQuery({
    queryKey: PROSPECTS_KEY,
    queryFn: () => api.get<Paged<Prospect[]>>('/staff/prospects?limit=100'),
  })
}
