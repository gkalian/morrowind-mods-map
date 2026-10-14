export type Lang = 'en' | 'ru'

export const LANGS: Lang[] = ['en', 'ru']

const STRINGS = {
  en: {
    title: 'Elderscrolls Morrowind Mods Map',
    search: 'Search location',
    legend: 'Legend',
    language: 'Русский язык',
    settlement: 'Settlement',
    entrance: 'Interior Entrance',
    region: 'Region',
    settlements: 'Settlements',
    entrances: 'Interior Entrances',
    regions: 'Regions',
    showSettlements: 'Settlements',
    showEntrances: 'Interior entrances',
    showRegionNames: 'Region names',
    showRegionColours: 'Region colours',
    showCellGrid: 'Cell grid',
    alwaysShown: '{set} is always shown',
    showSet: 'Show {set}',
    cell: 'Cell {x}, {y}',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    couldNotCopy: 'Could not copy',
    updated: 'Updated {date}',
    sourceCode: 'Source code on GitHub',
    credits: 'Credits',
    close: 'Close',
  },
  ru: {
    title: 'Карта Morrowind и модов',
    search: 'Поиск локации',
    legend: 'Легенда',
    language: 'English',
    settlement: 'Поселение',
    entrance: 'Вход в помещение',
    region: 'Регион',
    settlements: 'Поселения',
    entrances: 'Входы в помещения',
    regions: 'Регионы',
    showSettlements: 'Поселения',
    showEntrances: 'Входы в помещения',
    showRegionNames: 'Названия регионов',
    showRegionColours: 'Цвета регионов',
    showCellGrid: 'Сетка ячеек',
    alwaysShown: '{set} показывается всегда',
    showSet: 'Показать {set}',
    cell: 'Ячейка {x}, {y}',
    copyLink: 'Скопировать ссылку',
    linkCopied: 'Ссылка скопирована',
    couldNotCopy: 'Не удалось скопировать',
    updated: 'Обновлено {date}',
    sourceCode: 'Исходный код на GitHub',
    credits: 'Благодарности',
    close: 'Закрыть',
  },
} satisfies Record<Lang, Record<string, string>>

export type StringKey = keyof (typeof STRINGS)['en']

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
