import type { VersionInfo } from '@/utils/api'
import { getSharedApi } from '@/utils/api'

export async function loadServerVersion(): Promise<VersionInfo | null> {
  try {
    return await getSharedApi().getVersion()
  }
  catch {
    return null
  }
}
