/**
 * Browser half of dsh-maestro-codex: the assembly layer. Registers the
 * configuration card on the Plugins settings page (keyed by this package —
 * the plugin-manager renders it under `plugins.bundle.config`), following the
 * host entry through `configForms.describe()` so a deployment without the
 * host entry shows no trace of the card.
 *
 * @module dsh-maestro-codex/client
 */

import type { ClientContext } from './types.js'
import { MaestroCard } from './MaestroCard.js'
import { MaestroForm, type SectionValue } from './form.js'

/** The host entry id — the same string the host spells as its settings namespace. */
export const PLUGIN_ENTRY_ID = 'maestro-codex'

/** The plugin package name: the key the Plugins page dispatches the card by. */
export const PLUGIN_PACKAGE = 'dsh-maestro-codex'

/** Stable plugin id, matching the cordis.patch.yml row and the bundle id. */
export const name = PLUGIN_PACKAGE

/** Required services: the slot ledger and the config forms backing the card. */
export const inject = ['slots', 'configForms']

/**
 * Apply the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const settingsForm = ctx.configForms.get<SectionValue>(PLUGIN_ENTRY_ID)
  const form = new MaestroForm(settingsForm)
  const store = form.bind()

  const describeFace = ctx.configForms.describe()
  let configDisposer: (() => void) | undefined
  const syncCardSeat = (): void => {
    const snapshot = describeFace.getSnapshot()
    const served = snapshot.status === 'ready'
      && (snapshot.view?.namespaces?.some(entry => entry.ns === PLUGIN_ENTRY_ID) ?? false)
    if (served && configDisposer === undefined) {
      configDisposer = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_PACKAGE,
        inject: () => ({
          maestroStore: store,
          maestro: form.actions(),
        }),
      }, MaestroCard))
    } else if (!served && configDisposer !== undefined) {
      configDisposer()
      configDisposer = undefined
    }
  }
  const unsubscribeDescribe = describeFace.subscribe(syncCardSeat)
  void describeFace.ensure()
  syncCardSeat()
  ctx.effect(() => () => {
    unsubscribeDescribe()
    if (configDisposer !== undefined) configDisposer()
  }, 'maestro-codex: plugin config card lifecycle')
}
