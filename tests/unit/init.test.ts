import type { Client, NodeStatus } from '../../src/utils/rpc'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { calculatePollingInterval, InitManager, shouldLogPollingFailure } from '../../src/utils/init'
import { RpcError } from '../../src/utils/rpc'

interface Deferred<T> {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T) => void
}

interface TestHarness {
  appStore: {
    connectionError: boolean
    dataUpdateInterval: number
    loading: boolean
    publicSettings: unknown
    rpcTransportMode: 'http' | 'websocket'
    updateLoginState: (loggedIn: boolean, user?: unknown) => void
  }
  client: {
    call: <T>(method: string, params?: unknown, signal?: AbortSignal) => Promise<T>
    close: () => void
    ensureWebSocketConnectedWithPing: () => Promise<void>
    onWebSocketClose: (listener: () => void) => () => void
    setTransport: (useWebSocket: boolean) => void
  }
  events: string[]
  logins: boolean[]
  nodesStore: {
    clearNodes: () => void
    initNodes: (clients: Record<string, Client>, statuses: Record<string, NodeStatus>) => void
    updateNodeClients: () => void
    updateNodeStatuses: () => void
    updateWsState: (state: string, attempts?: number) => void
    wsConnectionState: string
    wsReconnectAttempts: number
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createHarness(call: TestHarness['client']['call']): TestHarness {
  const events: string[] = []
  const logins: boolean[] = []
  const appStore: TestHarness['appStore'] = {
    connectionError: false,
    dataUpdateInterval: 3600,
    loading: true,
    publicSettings: undefined,
    rpcTransportMode: 'websocket',
    updateLoginState(loggedIn) {
      events.push(`login:${loggedIn}`)
      logins.push(loggedIn)
    },
  }
  const nodesStore: TestHarness['nodesStore'] = {
    clearNodes: () => events.push('nodes:clear'),
    initNodes: () => events.push('nodes:init'),
    updateNodeClients: () => events.push('nodes:clients'),
    updateNodeStatuses: () => events.push('nodes:statuses'),
    updateWsState(state, attempts = 0) {
      nodesStore.wsConnectionState = state
      nodesStore.wsReconnectAttempts = attempts
      events.push(`ws:${state}`)
    },
    wsConnectionState: 'disconnected',
    wsReconnectAttempts: 0,
  }
  const client: TestHarness['client'] = {
    call,
    close: () => events.push('transport:close'),
    ensureWebSocketConnectedWithPing: async () => {},
    onWebSocketClose: () => () => {},
    setTransport: useWebSocket => events.push(`transport:${useWebSocket ? 'ws' : 'http'}`),
  }
  return { appStore, client, events, logins, nodesStore }
}

function createManager(
  harness: TestHarness,
  api: { getMe: (signal?: AbortSignal) => Promise<unknown>, getPublicSettings: (signal?: AbortSignal) => Promise<unknown> },
  ping: (signal?: AbortSignal) => Promise<string>,
  navigate: (path: string) => void = () => {},
): InitManager {
  const rpc = {
    close: () => harness.client.close(),
    getClient: () => harness.client,
    ping,
  }
  return new InitManager({ healthCheckAttempts: 1 }, {
    api,
    appStore: harness.appStore,
    navigate,
    nodesStore: harness.nodesStore,
    rpc,
  } as never)
}

function installBrowserEvents(): { document: EventTarget, window: EventTarget } {
  const browserWindow = new EventTarget()
  const browserDocument = new EventTarget()
  Object.defineProperty(browserDocument, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument })
  return { document: browserDocument, window: browserWindow }
}

async function nextTasks(count = 4): Promise<void> {
  for (let index = 0; index < count; index++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

let originalDocument: PropertyDescriptor | undefined
let originalWindow: PropertyDescriptor | undefined

beforeEach(() => {
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
})

afterEach(() => {
  if (originalDocument)
    Object.defineProperty(globalThis, 'document', originalDocument)
  else
    Reflect.deleteProperty(globalThis, 'document')
  if (originalWindow)
    Object.defineProperty(globalThis, 'window', originalWindow)
  else
    Reflect.deleteProperty(globalThis, 'window')
})

describe('InitManager lifecycle isolation', () => {
  test('ignores delayed startup responses after destroy', async () => {
    const clients = deferred<Record<string, Client>>()
    const statuses = deferred<Record<string, NodeStatus>>()
    const settings = deferred<unknown>()
    const me = deferred<unknown>()
    const ping = deferred<string>()
    const navigations: string[] = []
    const harness = createHarness(method => method === 'common:getNodes'
      ? clients.promise as never
      : statuses.promise as never)
    const manager = createManager(harness, {
      getMe: () => me.promise,
      getPublicSettings: () => settings.promise,
    }, () => ping.promise, path => navigations.push(path))

    const initializing = manager.init()
    manager.destroy()
    settings.resolve({ sitename: 'stale' })
    me.resolve({ logged_in: true })
    clients.resolve({})
    statuses.resolve({})
    ping.reject(new RpcError(403, 'permission denied'))
    await initializing

    expect(harness.appStore.publicSettings).toBeUndefined()
    expect(harness.logins).toEqual([])
    expect(harness.events).not.toContain('nodes:init')
    expect(harness.events.filter(event => event === 'nodes:clear')).toHaveLength(1)
    expect(navigations).toEqual([])
  })

  test('revalidates over HTTP before rebuilding the configured WebSocket', async () => {
    const browser = installBrowserEvents()
    const recoverySettings = deferred<unknown>()
    const recoveryMe = deferred<unknown>()
    const recoveryClients = deferred<Record<string, Client>>()
    const recoveryStatuses = deferred<Record<string, NodeStatus>>()
    let requestRound = 0
    const harness = createHarness((method) => {
      if (requestRound === 0)
        return Promise.resolve({}) as never
      return (method === 'common:getNodes' ? recoveryClients.promise : recoveryStatuses.promise) as never
    })
    const manager = createManager(harness, {
      getMe: () => requestRound === 0 ? Promise.resolve({ logged_in: true }) : recoveryMe.promise,
      getPublicSettings: () => requestRound === 0 ? Promise.resolve({}) : recoverySettings.promise,
    }, async () => 'pong')

    await manager.init()
    await nextTasks()
    expect(harness.events).toContain('transport:ws')
    harness.events.length = 0
    requestRound = 1
    browser.window.dispatchEvent(new Event('focus'))
    await nextTasks(1)

    expect(harness.events.slice(0, 3)).toEqual([
      'transport:http',
      'transport:close',
      'ws:disconnected',
    ])
    expect(harness.events).not.toContain('transport:ws')

    recoverySettings.resolve({})
    recoveryMe.resolve({ logged_in: false })
    recoveryClients.resolve({})
    recoveryStatuses.resolve({})
    await nextTasks()

    expect(harness.logins.at(-1)).toBe(false)
    expect(harness.events).toContain('nodes:init')
    expect(harness.events).toContain('transport:ws')
    manager.destroy()
  })

  test('coalesces repeated focus events into one session recovery', async () => {
    const browser = installBrowserEvents()
    const recoveryPing = deferred<string>()
    let pingRound = 0
    const harness = createHarness(async () => ({}))
    const manager = createManager(harness, {
      getMe: async () => ({ logged_in: true }),
      getPublicSettings: async () => ({}),
    }, async () => {
      pingRound++
      if (pingRound === 2)
        return recoveryPing.promise
      return 'pong'
    })

    await manager.init()
    harness.events.length = 0
    browser.window.dispatchEvent(new Event('focus'))
    await nextTasks(1)
    browser.window.dispatchEvent(new Event('focus'))
    await nextTasks(1)
    expect(pingRound).toBe(2)
    expect(harness.events.filter(event => event === 'transport:http')).toHaveLength(1)

    recoveryPing.resolve('pong')
    await nextTasks()

    expect(harness.events).toContain('nodes:init')
    expect(harness.events.filter(event => event === 'transport:ws')).toHaveLength(1)
    manager.destroy()
  })
})

describe('InitManager polling recovery', () => {
  test('backs off consecutive failures, caps the delay and throttles repeated logs', () => {
    expect(calculatePollingInterval(3_000, 0, 60_000)).toBe(3_000)
    expect(calculatePollingInterval(3_000, 1, 60_000)).toBe(6_000)
    expect(calculatePollingInterval(3_000, 2, 60_000)).toBe(12_000)
    expect(calculatePollingInterval(3_000, 5, 60_000)).toBe(60_000)
    expect(calculatePollingInterval(3_000, 100, 60_000)).toBe(60_000)

    expect([1, 2, 3, 4, 5, 8].filter(shouldLogPollingFailure)).toEqual([1, 2, 4, 8])
  })

  test('keeps applying realtime statuses when the periodic node metadata refresh fails', async () => {
    installBrowserEvents()
    let polling = false
    let metadataAttempts = 0
    const harness = createHarness((method) => {
      if (polling && method === 'common:getNodes') {
        metadataAttempts++
        return Promise.reject(new Error('metadata unavailable'))
      }
      return Promise.resolve({}) as never
    })
    harness.appStore.rpcTransportMode = 'http'
    const manager = createManager(harness, {
      getMe: async () => ({ logged_in: false }),
      getPublicSettings: async () => ({}),
    }, async () => 'pong')

    await manager.init()
    harness.events.length = 0
    polling = true
    const internal = manager as unknown as {
      lastClientsFetchAttemptAt: number
      lastClientsFetchedAt: number
      transportGeneration: number
      transport: {
        poll: (generation: number, refreshAfterCurrent?: boolean) => Promise<void>
        postFailureCount: number
      }
    }
    internal.lastClientsFetchedAt = 0
    internal.lastClientsFetchAttemptAt = 0

    await internal.transport.poll(internal.transportGeneration, false)

    expect(harness.events).toContain('nodes:statuses')
    expect(harness.events).not.toContain('nodes:clients')
    expect(harness.appStore.connectionError).toBe(false)
    expect(internal.transport.postFailureCount).toBe(0)
    expect(metadataAttempts).toBe(1)

    harness.events.length = 0
    await internal.transport.poll(internal.transportGeneration, false)
    expect(harness.events).toContain('nodes:statuses')
    expect(metadataAttempts).toBe(1)
    manager.destroy()
  })
})
