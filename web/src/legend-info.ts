import { t } from './i18n'
import type { PluginSet } from './manifest'
import type { TransportData } from './transport-data'

type InfoKind = 'transport' | 'intervention'
let active: HTMLButtonElement | null = null
let tooltip: HTMLElement | null = null
let pinned = false

function close(): void {
  active?.setAttribute('aria-expanded', 'false')
  active?.removeAttribute('aria-describedby')
  tooltip?.remove()
  active = null
  tooltip = null
  pinned = false
}

function position(): void {
  if (!active || !tooltip) return
  if (!active.isConnected) { close(); return }
  const rect = active.getBoundingClientRect()
  const legend = active.closest<HTMLElement>('.legend')
  const legendRect = legend?.getBoundingClientRect()
  if (legend?.hidden || (legendRect && (rect.bottom <= legendRect.top || rect.top >= legendRect.bottom))) { close(); return }
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft ?? 0
  const top = viewport?.offsetTop ?? 0
  const right = left + (viewport?.width ?? window.innerWidth)
  const bottom = top + (viewport?.height ?? window.innerHeight)
  tooltip.style.width = `${Math.min(300, right - left - 16)}px`
  const box = tooltip.getBoundingClientRect()
  const x = Math.max(left + 8, Math.min(rect.left, right - box.width - 8))
  const above = rect.top - box.height - 8
  const y = above >= top + 8 ? above : Math.min(rect.bottom + 8, bottom - box.height - 8)
  tooltip.style.left = `${x}px`
  tooltip.style.top = `${Math.max(top + 8, y)}px`
}

function show(button: HTMLButtonElement, kind: InfoKind, sets: PluginSet[], data: TransportData, pin: boolean): void {
  if (active === button && tooltip) { pinned = pin; return }
  close()
  const missing = sets.filter((set) => !set.backdropFor && (!data.sets.has(set.id) || (kind === 'intervention' && !data.sets.get(set.id)?.interventionReferences)))
  tooltip = document.createElement('div')
  tooltip.id = 'legend-info-tooltip'
  tooltip.className = 'legend-info-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  const text = document.createElement('div')
  text.textContent = t(missing.length ? (kind === 'transport' ? 'transportInfoMissing' : 'interventionInfoMissing') : 'legendInfoComplete')
  tooltip.append(text)
  if (missing.length) {
    const list = document.createElement('ul')
    for (const set of missing) {
      const item = document.createElement('li')
      item.textContent = set.name
      list.append(item)
    }
    tooltip.append(list)
  }
  active = button
  pinned = pin
  active.setAttribute('aria-expanded', 'true')
  active.setAttribute('aria-describedby', tooltip.id)
  document.body.append(tooltip)
  position()
}

export function closeLegendInfoWithin(container: HTMLElement): void {
  if (active && container.contains(active)) close()
}

export function createLegendInfo(kind: InfoKind, sets: PluginSet[], data: TransportData): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'legend-info'
  button.setAttribute('aria-label', t(kind === 'transport' ? 'transportInfoLabel' : 'interventionInfoLabel'))
  button.setAttribute('aria-expanded', 'false')
  const icon = document.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = 'i'
  button.append(icon)
  button.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse' && !pinned) show(button, kind, sets, data, false) })
  button.addEventListener('pointerleave', () => { if (active === button && !pinned && !button.matches(':focus-visible')) close() })
  button.addEventListener('focus', () => { if (button.matches(':focus-visible') && !pinned) show(button, kind, sets, data, false) })
  button.addEventListener('blur', () => { if (active === button && !pinned) close() })
  button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (active === button && pinned) close()
    else show(button, kind, sets, data, true)
  })
  return button
}

document.addEventListener('pointerdown', (event) => { if (active && !active.contains(event.target as Node)) close() })
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && active) close() })
document.addEventListener('scroll', position, true)
window.addEventListener('resize', position)
window.visualViewport?.addEventListener('resize', position)
window.visualViewport?.addEventListener('scroll', position)
