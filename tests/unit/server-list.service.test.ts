import type { NodeData } from '../../src/stores/nodes'
import type { Client } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { reconcileServerOrder, saveServerOrder } from '../../src/services/server-list.service'

function node(uuid: string, weight: number, name = uuid): Pick<NodeData, 'name' | 'uuid' | 'weight'> {
  return { name, uuid, weight }
}

describe('reconcileServerOrder', () => {
  test('removes deleted nodes and appends new nodes in official order', () => {
    const nodes = [
      node('new-last', 30),
      node('kept-b', 20),
      node('new-first', 10),
      node('kept-a', 0),
    ]

    expect(reconcileServerOrder(['kept-b', 'deleted', 'kept-a'], nodes)).toEqual([
      'kept-b',
      'kept-a',
      'new-first',
      'new-last',
    ])
  })

  test('does not preserve duplicate draft entries', () => {
    const nodes = [node('a', 0), node('b', 1)]
    expect(reconcileServerOrder(['b', 'b', 'a'], nodes)).toEqual(['b', 'a'])
  })

  test('rejects empty and duplicate orders before contacting the backend', async () => {
    await expect(saveServerOrder([])).rejects.toThrow('服务器顺序无效')
    await expect(saveServerOrder(['a', 'a'])).rejects.toThrow('服务器顺序无效')
  })

  test('reads Komari metadata back and accepts only the persisted order', async () => {
    const clients = {
      a: { uuid: 'a', weight: 1 },
      b: { uuid: 'b', weight: 0 },
    } as Record<string, Client>
    let savedOrder: Record<string, number> | undefined

    await expect(saveServerOrder(['b', 'a'], {
      orderClients: async (order) => {
        savedOrder = order
      },
      getNodesOverHttp: async () => clients,
    })).resolves.toBe(clients)
    expect(savedOrder).toEqual({ b: 0, a: 1 })
  })

  test('keeps the edit flow in an error state when persistence is incomplete', async () => {
    await expect(saveServerOrder(['b', 'a'], {
      orderClients: async () => {},
      getNodesOverHttp: async () => ({
        a: { uuid: 'a', weight: 0 },
        b: { uuid: 'b', weight: 1 },
      } as Record<string, Client>),
    })).rejects.toThrow('服务器顺序未完整保存')
  })
})
