import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { IpGeo } from '@/utils/ipGeoHelper'
import type { ProviderResolveResult } from '@/utils/providerInfo'
import { ref, toValue, watch } from 'vue'
import { lookupIpGeo } from '@/utils/ipGeoHelper'
import { resolveProviderInfo } from '@/utils/providerInfo'

export interface NodeProviderMetadata {
  provider: ProviderResolveResult | null
  geo: IpGeo | null
  loading: boolean
}

interface UseNodeProviderMetadataOptions {
  nodes: MaybeRefOrGetter<NodeData[]>
  customAliases: MaybeRefOrGetter<string>
  enabled?: MaybeRefOrGetter<boolean>
}

interface SharedCacheEntry {
  metadata: NodeProviderMetadata
  subscribers: Set<(metadata: NodeProviderMetadata) => void>
  promise: Promise<void> | null
}

const sharedMetadataCache = new Map<string, SharedCacheEntry>()

function getNodeIps(node: NodeData): string[] {
  return [node.ipv4, node.ipv6].filter((ip): ip is string => Boolean(ip?.trim()))
}

function getProviderMetadataText(node: NodeData): string {
  return [node.name, node.public_remark, node.remark, node.tags, node.group, node.region]
    .filter(Boolean)
    .join(' ')
}

function getFingerprint(node: NodeData, customAliases: string): string {
  return [
    node.uuid,
    node.name,
    node.public_remark,
    node.remark,
    node.tags,
    node.group,
    node.region,
    node.ipv4,
    node.ipv6,
    customAliases,
  ].join('')
}

async function lookupNodeGeo(node: NodeData): Promise<IpGeo | null> {
  for (const ip of getNodeIps(node)) {
    const geo = await lookupIpGeo(ip)
    if (geo)
      return geo
  }
  return null
}

function buildNodeProviderMetadata(node: NodeData, customAliases: string, geo: IpGeo | null, loading: boolean): NodeProviderMetadata {
  return {
    geo,
    loading,
    provider: resolveProviderInfo({
      metadata: getProviderMetadataText(node),
      org: geo?.org,
      asn: geo?.asn,
      customAliases,
    }),
  }
}

function notifySharedEntry(entry: SharedCacheEntry): void {
  for (const subscriber of entry.subscribers)
    subscriber(entry.metadata)
}

function getSharedMetadataEntry(node: NodeData, customAliases: string): { fingerprint: string, entry: SharedCacheEntry } {
  const fingerprint = getFingerprint(node, customAliases)
  const cached = sharedMetadataCache.get(fingerprint)
  if (cached)
    return { fingerprint, entry: cached }

  const hasIps = getNodeIps(node).length > 0
  const entry: SharedCacheEntry = {
    metadata: buildNodeProviderMetadata(node, customAliases, null, hasIps),
    subscribers: new Set(),
    promise: null,
  }
  sharedMetadataCache.set(fingerprint, entry)

  if (hasIps) {
    entry.promise = lookupNodeGeo(node)
      .then((geo) => {
        entry.metadata = buildNodeProviderMetadata(node, customAliases, geo, false)
        notifySharedEntry(entry)
      })
      .catch(() => {
        entry.metadata = buildNodeProviderMetadata(node, customAliases, null, false)
        notifySharedEntry(entry)
      })
      .finally(() => {
        entry.promise = null
      })
  }

  return { fingerprint, entry }
}

export function useNodeProviderMetadata(options: UseNodeProviderMetadataOptions) {
  const metadataByUuid = ref<Record<string, NodeProviderMetadata>>({})
  const activeFingerprints = new Map<string, string>()
  let refreshSeq = 0

  function getNodeProviderMetadata(node: NodeData): NodeProviderMetadata | null {
    return metadataByUuid.value[node.uuid] ?? null
  }

  watch(
    () => {
      const nodes = toValue(options.nodes)
      const customAliases = toValue(options.customAliases)
      const enabled = options.enabled === undefined ? true : toValue(options.enabled)
      return {
        customAliases,
        enabled,
        fingerprint: nodes.map(node => getFingerprint(node, customAliases)).join(''),
      }
    },
    ({ customAliases, enabled }, _previous, onCleanup) => {
      const seq = ++refreshSeq
      const nodes = toValue(options.nodes)
      const nextMetadata: Record<string, NodeProviderMetadata> = {}
      const unsubscribers: Array<() => void> = []
      activeFingerprints.clear()

      onCleanup(() => {
        for (const unsubscribe of unsubscribers)
          unsubscribe()
      })

      if (!enabled) {
        metadataByUuid.value = nextMetadata
        return
      }

      for (const node of nodes) {
        const { fingerprint, entry } = getSharedMetadataEntry(node, customAliases)
        activeFingerprints.set(node.uuid, fingerprint)
        nextMetadata[node.uuid] = entry.metadata

        const subscriber = (metadata: NodeProviderMetadata) => {
          if (seq !== refreshSeq || activeFingerprints.get(node.uuid) !== fingerprint)
            return

          metadataByUuid.value = {
            ...metadataByUuid.value,
            [node.uuid]: metadata,
          }
        }
        entry.subscribers.add(subscriber)
        unsubscribers.push(() => entry.subscribers.delete(subscriber))
      }

      metadataByUuid.value = nextMetadata
    },
    { immediate: true },
  )

  return {
    metadataByUuid,
    getNodeProviderMetadata,
  }
}
