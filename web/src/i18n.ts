import en from './locales/en.json'
import ru from './locales/ru.json'

export type Lang = 'en' | 'ru'

export const LANGS: Lang[] = ['en', 'ru']

export type StringKey = keyof typeof en

/** Every language must have every key English has; `tsc` fails otherwise. */
const STRINGS: Record<Lang, Record<StringKey, string>> = { en, ru }

const STORAGE_KEY = 'lang'

function isLang(value: unknown): value is Lang {
  return LANGS.includes(value as Lang)
}

/** The language from the link, then the one chosen last time, then the browser's. */
function initialLang(): Lang {
  const linked = new URLSearchParams(location.search).get('lang')
  if (isLang(linked)) return linked
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    // Storage can be blocked; the browser's language decides then.
  }
  return navigator.languages.some((language) => language.toLowerCase().startsWith('ru')) ? 'ru' : 'en'
}

let current: Lang = initialLang()
const listeners: (() => void)[] = []

export function lang(): Lang {
  return current
}

/** Text of the interface in the current language, with `{name}` filled in from `values`. */
export function t(key: StringKey, values: Record<string, string | number> = {}): string {
  return STRINGS[current][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
}

export function setLang(next: Lang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Remembering the choice is only a convenience.
  }
  applyToDocument()
  for (const listener of listeners) listener()
}

/** Calls `listener` every time the language changes. */
export function onLangChange(listener: () => void): void {
  listeners.push(listener)
}

export function applyToDocument(): void {
  document.documentElement.lang = current
  document.title = t('title')
}
