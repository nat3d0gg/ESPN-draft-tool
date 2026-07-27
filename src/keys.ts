/** Central place for the Redis key layout so it stays consistent. */

export function stateKey(prefix: string, draftId: string): string {
  return `${prefix}:${draftId}:state`;
}

export function eventsChannel(prefix: string, draftId: string): string {
  return `${prefix}:${draftId}:events`;
}
