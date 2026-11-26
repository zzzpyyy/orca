// The local DingTalk connector on any host that runs connectors: desktop, `orca serve` and orcad.
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installDingTalkLocalConnector } from './dingtalk-local-connector'

/** Starts the connector, which stays off until its setup enables it; returns its stop. */
export function installDingTalkLocal(
  runtime: OrcaRuntimeService,
  store: Store,
  userDataPath: string
): () => void {
  const connector = installDingTalkLocalConnector({
    userDataPath,
    seam: () => runtime.getExternalConversationSeam(),
    host: () => runtimeConversationHost(runtime),
    bots: () => store.getBots(),
    changed: (botIds) => runtime.notifyBotsChanged({ botIds, kinds: ['settings'] })
  })
  runtime.dingtalkLocal = connector
  const unregister = runtime.localConnectors.add(connector)
  void connector.start().catch((error: unknown) => {
    console.error('[dingtalk-local] startup failed', error)
  })
  return () => {
    unregister()
    if (runtime.dingtalkLocal === connector) {
      runtime.dingtalkLocal = null
    }
    void connector.stop().catch((error: unknown) => {
      console.error('[dingtalk-local] shutdown failed', error)
    })
  }
}
