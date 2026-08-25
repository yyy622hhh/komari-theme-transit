import type { Client, NodeStatus } from '../../src/utils/rpcTypes'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { useNodesStore } from '../../src/stores/nodes'

const originalLocalStorage = globalThis.localStorage

function client(partial: Partial<Client> & { uuid: string }): Client {
  return {
    uuid: partial.uuid,
    name: 'node',
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 1,
    os: '',
    kernel_version: '',
    region: 'CN',
    public_remark: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    weight: 0,
    price: 0,
    billing_cycle: 0,
    auto_renewal: false,
    currency: '',
    expired_at: null,
    group: '',
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: '',
    ...partial,
  }
}

function status(partial: Partial<NodeStatus> = {}): NodeStatus {
  return {
    client: '',
    time: '2026-01-01T00:00:00.000Z',
    cpu: 0,
    gpu: 0,
    ram: 0,
    ram_total: 0,
    swap: 0,
    swap_total: 0,
    load: 0,
    load5: 0,
    load15: 0,
    temp: 0,
    disk: 0,
    disk_total: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    online: true,
    uptime: 0,
    ...partial,
  }
}

beforeEach(() => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    },
  })
  setActivePinia(createPinia())
})

afterEach(() => {
  setAuthSessionFromLogin(false)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

describe('initNodes', () => {
  test('creates a node with client fields and defaulted-then-applied status', () => {
    const store = useNodesStore()
    store.initNodes(
      { a: client({ uuid: 'a', name: 'Alpha', weight: 5, group: '香港;日本' }) },
      { a: status({ online: true, cpu: 42 }) },
    )

    expect(store.nodes).toHaveLength(1)
    const node = store.nodesByUuid.get('a')
    expect(node?.name).toBe('Alpha')
    expect(node?.groups).toEqual(['香港', '日本'])
    expect(node?.online).toBe(true)
    expect(node?.cpu).toBe(42)
  })

  test('defaults status fields to offline/zero when no status is supplied yet', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a' }) }, {})
    const node = store.nodesByUuid.get('a')
    expect(node?.online).toBe(false)
    expect(node?.cpu).toBe(0)
    expect(node?.ram).toBe(0)
  })

  test('reuses the same node object reference on a repeated call instead of replacing it', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a', name: 'Alpha' }) }, { a: status() })
    const before = store.nodesByUuid.get('a')

    store.initNodes({ a: client({ uuid: 'a', name: 'Alpha renamed' }) }, { a: status({ cpu: 10 }) })
    const after = store.nodesByUuid.get('a')

    expect(after).toBe(before)
    expect(after?.name).toBe('Alpha renamed')
    expect(after?.cpu).toBe(10)
  })

  test('drops nodes that are no longer present in the client map', () => {
    const store = useNodesStore()
    store.initNodes(
      { a: client({ uuid: 'a' }), b: client({ uuid: 'b' }) },
      {},
    )
    expect(store.nodes).toHaveLength(2)

    store.initNodes({ a: client({ uuid: 'a' }) }, {})
    expect(store.nodes).toHaveLength(1)
    expect(store.nodesByUuid.get('b')).toBeUndefined()
  })

  test('sorts ascending by weight, then by zh-CN name on a tie', () => {
    const store = useNodesStore()
    store.initNodes(
      {
        b: client({ uuid: 'b', name: '北京', weight: 1 }),
        a: client({ uuid: 'a', name: '上海', weight: 1 }),
        c: client({ uuid: 'c', name: 'Any', weight: 0 }),
      },
      {},
    )
    expect(store.nodes.map(n => n.uuid)).toEqual(['c', 'b', 'a'])
  })
})

describe('updateNodeStatuses', () => {
  function seeded() {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a' }) }, {})
    return store
  }

  test('prefers gpu_average_usage over the raw gpu field when both are present', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ gpu: 5, gpu_average_usage: 77 }) })
    expect(store.nodesByUuid.get('a')?.gpu).toBe(77)
  })

  test('falls back to gpu when gpu_average_usage is absent', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ gpu: 33, gpu_average_usage: undefined }) })
    expect(store.nodesByUuid.get('a')?.gpu).toBe(33)
  })

  test('load5 falls back to load, and load15 falls back to load5, when unset', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ load: 9, load5: undefined as unknown as number, load15: undefined as unknown as number }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.load5).toBe(9)
    expect(node?.load15).toBe(9)
  })

  test('treats NaN and Infinity as absent and falls back to 0', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ cpu: Number.NaN, ram: Number.POSITIVE_INFINITY }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.cpu).toBe(0)
    expect(node?.ram).toBe(0)
  })

  test('normalizes connections so udp never exceeds the reported total', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ connections: 10, connections_udp: 40 }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.connections_udp).toBe(10)
    expect(node?.connections).toBe(0)
  })

  test('ignores a status update for an unknown uuid without creating a node', () => {
    const store = seeded()
    store.updateNodeStatuses({ ghost: status() })
    expect(store.nodes).toHaveLength(1)
    expect(store.nodesByUuid.get('ghost')).toBeUndefined()
  })

  test('propagates message and status_updated_at', () => {
    const store = seeded()
    store.updateNodeStatuses({ a: status({ message: 'disk full', updated_at: '2026-02-01T00:00:00.000Z' }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.message).toBe('disk full')
    expect(node?.status_updated_at).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('updateNodeClients', () => {
  test('adds a new node with defaulted status fields when it has no prior status', () => {
    const store = useNodesStore()
    store.updateNodeClients({ a: client({ uuid: 'a', name: 'Alpha' }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.name).toBe('Alpha')
    expect(node?.online).toBe(false)
  })

  test('re-sorts when a weight change reorders the nodes', () => {
    const store = useNodesStore()
    store.initNodes(
      { a: client({ uuid: 'a', name: 'A', weight: 0 }), b: client({ uuid: 'b', name: 'B', weight: 1 }) },
      {},
    )
    store.updateNodeClients({
      a: client({ uuid: 'a', name: 'A', weight: 5 }),
      b: client({ uuid: 'b', name: 'B', weight: 1 }),
    })
    expect(store.nodes.map(n => n.uuid)).toEqual(['b', 'a'])
  })

  test('keeps the groups array reference stable when the group string round-trips to the same list', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a', group: '香港;日本' }) }, {})
    const before = store.nodesByUuid.get('a')?.groups

    store.updateNodeClients({ a: client({ uuid: 'a', group: '香港;日本;香港' }) })
    const after = store.nodesByUuid.get('a')?.groups

    expect(after).toBe(before)
    expect(after).toEqual(['香港', '日本'])
  })

  test('gives the groups array a new reference when the parsed content actually changes', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a', group: '香港' }) }, {})
    const before = store.nodesByUuid.get('a')?.groups

    store.updateNodeClients({ a: client({ uuid: 'a', group: '日本' }) })
    const after = store.nodesByUuid.get('a')?.groups

    expect(after).not.toBe(before)
    expect(after).toEqual(['日本'])
  })

  test('removes a node absent from the new client map and forgets its status updates', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a' }), b: client({ uuid: 'b' }) }, {})

    store.updateNodeClients({ a: client({ uuid: 'a' }) })
    expect(store.nodes).toHaveLength(1)
    expect(store.nodesByUuid.get('b')).toBeUndefined()

    store.updateNodeStatuses({ b: status({ cpu: 99 }) })
    expect(store.nodesByUuid.get('b')).toBeUndefined()
  })

  test('preserves already-applied status fields for a node that only gets a client update', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a' }) }, { a: status({ cpu: 55 }) })

    store.updateNodeClients({ a: client({ uuid: 'a', name: 'Renamed' }) })
    const node = store.nodesByUuid.get('a')
    expect(node?.name).toBe('Renamed')
    expect(node?.cpu).toBe(55)
  })
})

describe('applyNodeOrder', () => {
  test('places ordered uuids first, in the given order, ahead of the remaining nodes', () => {
    const store = useNodesStore()
    store.initNodes(
      {
        a: client({ uuid: 'a', name: 'A', weight: 0 }),
        b: client({ uuid: 'b', name: 'B', weight: 1 }),
        c: client({ uuid: 'c', name: 'C', weight: 2 }),
      },
      {},
    )

    store.applyNodeOrder(['c', 'a'])
    expect(store.nodes.map(n => n.uuid)).toEqual(['c', 'a', 'b'])
    expect(store.nodesByUuid.get('c')?.weight).toBe(0)
    expect(store.nodesByUuid.get('a')?.weight).toBe(1)
    expect(store.nodesByUuid.get('b')?.weight).toBe(2)
  })

  test('ignores unknown and duplicate uuids in the requested order', () => {
    const store = useNodesStore()
    store.initNodes(
      { a: client({ uuid: 'a', name: 'A', weight: 0 }), b: client({ uuid: 'b', name: 'B', weight: 1 }) },
      {},
    )

    store.applyNodeOrder(['b', 'ghost', 'b', 'a'])
    expect(store.nodes.map(n => n.uuid)).toEqual(['b', 'a'])
  })

  test('sorts the un-ordered remainder by weight, then by zh-CN name on a tie', () => {
    const store = useNodesStore()
    store.initNodes(
      {
        pinned: client({ uuid: 'pinned', name: 'Pinned', weight: 0 }),
        d: client({ uuid: 'd', name: '北京', weight: 5 }),
        c: client({ uuid: 'c', name: '上海', weight: 5 }),
        e: client({ uuid: 'e', name: 'Any', weight: 1 }),
      },
      {},
    )

    store.applyNodeOrder(['pinned'])
    expect(store.nodes.map(n => n.uuid)).toEqual(['pinned', 'e', 'd', 'c'])
  })
})

describe('updateWsState', () => {
  test('updates the connection state and leaves attempts untouched when omitted', () => {
    const store = useNodesStore()
    store.updateWsState('reconnecting')
    expect(store.wsConnectionState).toBe('reconnecting')
    expect(store.wsReconnectAttempts).toBe(0)
  })

  test('updates attempts when explicitly provided', () => {
    const store = useNodesStore()
    store.updateWsState('reconnecting', 3)
    expect(store.wsReconnectAttempts).toBe(3)
    store.updateWsState('connected')
    expect(store.wsReconnectAttempts).toBe(3)
  })
})

describe('clearNodes', () => {
  test('empties the node list and forgets all lookups', () => {
    const store = useNodesStore()
    store.initNodes({ a: client({ uuid: 'a' }) }, {})
    store.clearNodes()

    expect(store.nodes).toHaveLength(0)
    expect(store.totalCount).toBe(0)
    expect(store.nodesByUuid.get('a')).toBeUndefined()

    store.updateNodeStatuses({ a: status() })
    expect(store.nodesByUuid.get('a')).toBeUndefined()
  })
})

describe('visibility and derived collections', () => {
  function seededWithHiddenNode() {
    const store = useNodesStore()
    store.initNodes(
      {
        visible: client({ uuid: 'visible', name: 'Visible', hidden: false, group: '香港', weight: 0 }),
        hidden: client({ uuid: 'hidden', name: 'Hidden', hidden: true, group: '日本', weight: 1 }),
      },
      {
        visible: status({ online: true }),
        hidden: status({ online: true }),
      },
    )
    return store
  }

  test('excludes hidden nodes from visibleNodes for a guest', () => {
    const store = seededWithHiddenNode()
    expect(store.visibleNodes.map(n => n.uuid)).toEqual(['visible'])
    expect(store.totalCount).toBe(1)
    expect(store.onlineCount).toBe(1)
    expect(store.groups).toEqual(['香港'])
    expect(store.visibleNodesByUuid.get('hidden')).toBeUndefined()
  })

  test('includes hidden nodes once authenticated', () => {
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
    const store = seededWithHiddenNode()
    expect(store.visibleNodes.map(n => n.uuid).sort()).toEqual(['hidden', 'visible'])
    expect(store.totalCount).toBe(2)
    expect(store.groups.sort()).toEqual(['日本', '香港'])
  })

  test('nodesByUuid always includes hidden nodes regardless of auth state', () => {
    const store = seededWithHiddenNode()
    expect(store.nodesByUuid.get('hidden')).toBeDefined()
    expect(store.visibleNodesByUuid.get('hidden')).toBeUndefined()
  })
})
