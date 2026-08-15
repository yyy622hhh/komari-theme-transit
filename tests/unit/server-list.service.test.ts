import type { NodeData } from '../../src/stores/nodes'
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
})
