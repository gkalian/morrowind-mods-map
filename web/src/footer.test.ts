import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFooter } from './footer'
import { setLang } from './i18n'
import { manifest } from './test-helpers'

afterEach(() => {
  setLang('en')
  document.body.replaceChildren()
})

function open() {
  // 22 November 2026, noon UTC: the same day in every time zone the test may run in.
  const footer = createFooter(manifest(['morrowind'], { build: Date.UTC(2026, 10, 22, 12) / 1000 }))
  document.body.append(footer)
  const dialog = footer.querySelector('dialog')!
  // The light browser of the tests has no modal dialogs of its own.
  dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''))
  dialog.close = vi.fn(() => dialog.removeAttribute('open'))
  return { footer, dialog, credits: footer.querySelector<HTMLButtonElement>(':scope > button')! }
}

describe('the footer', () => {
  it('tells when the data was built, in the current language', () => {
    const { footer } = open()
    expect(footer.querySelector('span')!.textContent).toBe('Updated 22 November 2026')
    setLang('ru')
    expect(footer.querySelector('span')!.textContent).toBe('Обновлено 22 ноября 2026 г.')
    expect(footer.querySelector('a')!.getAttribute('aria-label')).toBe('Исходный код на GitHub')
  })

  it('opens the credits, with links to the authors, and closes them', () => {
    const { dialog, credits } = open()
    credits.click()
    expect(dialog.showModal).toHaveBeenCalled()
    expect([...dialog.querySelectorAll('h3')].map((title) => title.textContent)).toContain('Mods')
    expect(dialog.querySelector('a[href="https://github.com/Greatness7/tes3"]')).not.toBeNull()
    dialog.querySelector<HTMLButtonElement>(':scope > button')!.click()
    dialog.dispatchEvent(new MouseEvent('click'))
    dialog.querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dialog.close).toHaveBeenCalledTimes(2)
  })

  it('translates the credits with the page', () => {
    const { dialog } = open()
    setLang('ru')
    expect(dialog.querySelector('h2')!.textContent).toBe('Благодарности')
  })
})
