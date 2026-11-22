import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lang, localName, onLangChange, setLang, t } from './i18n'
import en from './locales/en.json'
import ru from './locales/ru.json'

beforeEach(() => localStorage.clear())
afterEach(() => {
  setLang('en')
  history.replaceState(null, '', '/')
})

describe('dictionaries', () => {
  it('have the same keys and no empty texts', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
    for (const dictionary of [en, ru]) {
      expect(Object.entries(dictionary).filter(([, text]) => !text.trim())).toEqual([])
    }
  })

  it('use the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]))
    }
  })
})

describe('t', () => {
  it('fills in the placeholders and leaves missing ones empty', () => {
    expect(t('cell', { x: 1, y: -2 })).toBe('Cell 1, -2')
    expect(t('cell', { x: 1 })).toBe('Cell 1, ')
  })

  it('speaks the language that is set', () => {
    setLang('ru')
    expect(t('legend')).toBe('Легенда')
  })
})

describe('setLang', () => {
  it('tells the listeners, updates the page and remembers the choice', () => {
    const listener = vi.fn()
    onLangChange(listener)
    setLang('ru')
    expect([lang(), document.documentElement.lang, document.title, localStorage.getItem('lang')]).toEqual(['ru', 'ru', ru.title, 'ru'])
    expect(listener).toHaveBeenCalledTimes(1)
    setLang('ru')
    expect(listener, 'nothing changed').toHaveBeenCalledTimes(1)
  })

  it('works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setLang('ru')
    expect(lang()).toBe('ru')
  })
})

describe('the first language', () => {
  async function firstLang(): Promise<string> {
    vi.resetModules()
    return (await import('./i18n')).lang()
  }

  it('comes from the link, then from the last choice, then from the browser', async () => {
    history.replaceState(null, '', '/?lang=ru')
    expect(await firstLang()).toBe('ru')
    history.replaceState(null, '', '/?lang=xx')
    localStorage.setItem('lang', 'ru')
    expect(await firstLang()).toBe('ru')
    localStorage.clear()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU', 'en'])
    expect(await firstLang()).toBe('ru')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE'])
    expect(await firstLang()).toBe('en')
  })

  it('falls back to the browser when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru'])
    expect(await firstLang()).toBe('ru')
  })
})

describe('localName', () => {
  it('takes the Russian name in Russian, and the English one otherwise or when there is none', () => {
    expect(localName({ name: 'Balmora', ru: 'Балмора' })).toBe('Balmora')
    setLang('ru')
    expect(localName({ name: 'Balmora', ru: 'Балмора' })).toBe('Балмора')
    expect(localName({ name: 'Balmora' })).toBe('Balmora')
  })
})
