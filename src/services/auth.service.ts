import type { MeInfo } from '@/utils/api'
import { SECURITY_CONFIG } from '@/constants/security'
import { getSharedApi } from '@/utils/api'

export type AuthStatus = 'unknown' | 'guest' | 'authenticated' | 'error'
export type PermissionKey
  = | 'advancedTools'
    | 'snapshotExport'
    | 'healthSummary'
    | 'providerValue'
    | 'nodeTopology'
    | 'serverList'
    | 'auditLog'
    | 'diskPrediction'
    | 'providerGeoLookup'

export interface AuthSession {
  status: AuthStatus
  authenticated: boolean
  user: MeInfo | null
  lastVerifiedAt: number
  errorMessage?: string
}

export interface VerifyLoginOptions {
  force?: boolean
}

export interface PermissionResult {
  granted: boolean
  session: AuthSession
  reason?: string
}

let authSession: AuthSession = {
  status: 'unknown',
  authenticated: false,
  user: null,
  lastVerifiedAt: 0,
}
let verifyPromise: Promise<AuthSession> | null = null
let authSessionRevision = 0

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createSessionFromMe(user: MeInfo): AuthSession {
  const authenticated = Boolean(user.logged_in)
  return {
    status: authenticated ? 'authenticated' : 'guest',
    authenticated,
    user: authenticated ? user : null,
    lastVerifiedAt: Date.now(),
  }
}

export function getAuthSession(): AuthSession {
  return authSession
}

export function isAuthenticated(): boolean {
  return authSession.authenticated
}

export function getCurrentUser(): MeInfo | null {
  return authSession.user
}

export function setAuthSessionFromLogin(loggedIn: boolean, user: MeInfo | null = null): AuthSession {
  authSessionRevision += 1
  verifyPromise = null
  authSession = {
    status: loggedIn ? 'authenticated' : 'guest',
    authenticated: loggedIn,
    user: loggedIn ? user : null,
    lastVerifiedAt: Date.now(),
  }
  return authSession
}

export async function verifyLogin(options: VerifyLoginOptions = {}): Promise<AuthSession> {
  const now = Date.now()
  const freshEnough = now - authSession.lastVerifiedAt < SECURITY_CONFIG.auth.verifyTtl
  if (!options.force && authSession.status !== 'unknown' && freshEnough)
    return authSession

  if (verifyPromise)
    return verifyPromise

  const revision = authSessionRevision
  const pendingVerification = getSharedApi().getMe().then((user) => {
    if (revision !== authSessionRevision)
      return authSession

    authSession = createSessionFromMe(user)
    return authSession
  }).catch((error) => {
    if (revision !== authSessionRevision)
      return authSession

    authSession = {
      status: 'error',
      authenticated: false,
      user: null,
      lastVerifiedAt: Date.now(),
      errorMessage: getErrorMessage(error),
    }
    return authSession
  }).finally(() => {
    if (verifyPromise === pendingVerification)
      verifyPromise = null
  })

  verifyPromise = pendingVerification
  return pendingVerification
}

export async function requirePermission(permission: PermissionKey, options: VerifyLoginOptions = { force: true }): Promise<PermissionResult> {
  const session = await verifyLogin(options)
  if (session.authenticated) {
    return {
      granted: true,
      session,
    }
  }

  return {
    granted: false,
    session,
    reason: `${permission} requires a verified login session`,
  }
}
