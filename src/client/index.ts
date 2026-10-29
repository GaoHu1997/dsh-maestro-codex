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

/** The host entry id — the cordis.patch.yml row id, and the settings namespace
 * the configForms service projects this plugin's volatile config under. */
export const PLUGIN_ENTRY_ID = 'dsh-maestro-codex'

/** The plugin package name: the key the Plugins page dispatches the card by. */
export const PLUGIN_PACKAGE = 'dsh-maestro-codex'

/** Stable plugin id, matching the cordis.patch.yml row and the bundle id. */
export const name = PLUGIN_PACKAGE

/** Required services: the slot ledger, the config forms backing the card, and
 * the workspace registry (the dispatch form's cwd auto-fill). */
export const inject = ['slots', 'configForms', 'workspaces']

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
  let sectionDisposer: (() => void) | undefined
  const syncCardSeat = (): void => {
    const snapshot = describeFace.getSnapshot()
    const served = snapshot.status === 'ready'
      && (snapshot.view?.namespaces?.some(entry => entry.ns === PLUGIN_ENTRY_ID) ?? false)
    if (served && configDisposer === undefined) {
      const workspacePaths = (): string[] => {
        const items = ctx.workspaces?.list.getSnapshot().items ?? []
        return items.map(item => item.path ?? '').filter(path => path !== '')
      }
      const register = (): unknown => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_PACKAGE,
        inject: () => ({
          maestroStore: store,
          maestro: form.actions(),
          workspaces: workspacePaths(),
        }),
      }, MaestroCard)
      configDisposer = ctx.slots.inject('plugins.bundle.config', register)
      // A settings-page nav entry of our own (the left menu), rendering the
      // same card. Registration options are plain data; a shape mismatch must
      // not take the rest of the client down.
      try {
        sectionDisposer = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'maestro-codex',
          order: 90,
          label: 'CLI 配置',
          inject: () => ({
            maestroStore: store,
            maestro: form.actions(),
            workspaces: workspacePaths(),
          }),
        }, MaestroCard))
      } catch {
        sectionDisposer = undefined
      }
    } else if (!served && configDisposer !== undefined) {
      configDisposer()
      configDisposer = undefined
      if (sectionDisposer !== undefined) {
        sectionDisposer()
        sectionDisposer = undefined
      }
    }
  }
  const unsubscribeDescribe = describeFace.subscribe(syncCardSeat)
  void describeFace.ensure()
  syncCardSeat()
  ctx.effect(() => () => {
    unsubscribeDescribe()
    if (configDisposer !== undefined) configDisposer()
    if (sectionDisposer !== undefined) sectionDisposer()
  }, 'maestro-codex: plugin config card lifecycle')
}
