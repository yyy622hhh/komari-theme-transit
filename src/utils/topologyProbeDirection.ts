/** Only draw a probe arrow when its resolved source matches the configured hop. */
export function topologyProbeDirection(segmentIndex: number, live: boolean, actualSource?: string, expectedSource?: string): 'reverse' | 'forward' | undefined {
  if (!live || !actualSource || !expectedSource || actualSource !== expectedSource)
    return undefined
  return segmentIndex === 0 ? 'reverse' : 'forward'
}
