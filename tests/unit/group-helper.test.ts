import { describe, expect, test } from 'bun:test'
import { isNodeInGroup, parseNodeGroups } from '../../src/utils/groupHelper'

describe('parseNodeGroups', () => {
  test('returns an empty list for null, undefined or empty input', () => {
    expect(parseNodeGroups(null)).toEqual([])
    expect(parseNodeGroups(undefined)).toEqual([])
    expect(parseNodeGroups('')).toEqual([])
  })

  test('splits on semicolons and trims each entry', () => {
    expect(parseNodeGroups('香港; 日本 ;美国')).toEqual(['香港', '日本', '美国'])
  })

  test('drops empty segments left by leading, trailing or doubled separators', () => {
    expect(parseNodeGroups(';香港;;日本;')).toEqual(['香港', '日本'])
  })

  test('drops duplicates while preserving first-seen order', () => {
    expect(parseNodeGroups('香港;日本;香港')).toEqual(['香港', '日本'])
  })

  test('a whitespace-only group string yields an empty list', () => {
    expect(parseNodeGroups('   ')).toEqual([])
  })
})

describe('isNodeInGroup', () => {
  test('"all" always matches, even for a node with no groups', () => {
    expect(isNodeInGroup(null, 'all')).toBe(true)
    expect(isNodeInGroup('香港', 'all')).toBe(true)
  })

  test('matches when the selected group is among the node\'s groups', () => {
    expect(isNodeInGroup('香港;日本', '日本')).toBe(true)
  })

  test('does not match a group the node is not in', () => {
    expect(isNodeInGroup('香港;日本', '美国')).toBe(false)
    expect(isNodeInGroup(null, '香港')).toBe(false)
  })
})
