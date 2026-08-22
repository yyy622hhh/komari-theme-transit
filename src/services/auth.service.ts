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
    | 'nodeCardPanel'
    | 'diagnostics'

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
let verifyPromiseForced = false
let verifyGeneration = 0
let authSessionRevision = 0
const authSessionListeners = new Set<(session: AuthSession) => void>()

function publishAuthSession(): void {
  for (const listener of authSessionListeners) {
    try {
      listener(authSession)
    }
    catch {
    }
  }
}

function updateAuthSession(session: AuthSession): AuthSession {
  authSession = session
  publishAuthSession()
  return authSession
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createSessionFromMe(user: MeInfo): AuthSession {
  const authenticated = user?.logged_in === true
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

export function subscribeAuthSession(listener: (session: AuthSession) => void): () => void {
  authSessionListeners.add(listener)
  return () => authSessionListeners.delete(listener)
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
  verifyPromiseForced = false
  return updateAuthSession({
    status: loggedIn ? 'authenticated' : 'guest',
    authenticated: loggedIn,
    user: loggedIn ? user : null,
    lastVerifiedAt: Date.now(),
  })
}

export async function verifyLogin(options: VerifyLoginOptions = {}): Promise<AuthSession> {
  const now = Date.now()
  const freshEnough = now - authSession.lastVerifiedAt < SECURITY_CONFIG.auth.verifyTtl
  if (!options.force && authSession.status !== 'unknown' && authSession.status !== 'error' && freshEnough)
    return authSession

  const force = Boolean(options.force)
  // 非强制请求可以复用在途结果；强制校验不能加入一次可能已过期的普通 /me。
  if (verifyPromise && (!force || verifyPromiseForced))
    return verifyPromise

  const revision = authSessionRevision
  const generation = ++verifyGeneration
  const pendingVerification = getSharedApi().getMe().then((user) => {
    if (revision !== authSessionRevision || generation !== verifyGeneration)
      return authSession

    return updateAuthSession(createSessionFromMe(user))
  }).catch((error) => {
    if (revision !== authSessionRevision || generation !== verifyGeneration)
      return authSession

    return updateAuthSession({
      status: 'error',
      authenticated: false,
      user: null,
      lastVerifiedAt: Date.now(),
      errorMessage: getErrorMessage(error),
    })
  }).finally(() => {
    if (verifyPromise === pendingVerification)
      verifyPromise = null
  })

  verifyPromise = pendingVerification
  verifyPromiseForced = force
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
