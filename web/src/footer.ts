import { onLangChange, t, type StringKey } from './i18n'
import type { Manifest } from './manifest'

interface Credit {
  name: string
  url?: string
  /** What it is to this Map. */
  role: StringKey
  /** Words that come before the name. */
  lead?: StringKey
}

const CREDITS: { title: StringKey; entries: Credit[] }[] = [
  {
    title: 'creditsGame',
    entries: [
      { name: 'The Elder Scrolls III: Morrowind', url: 'https://elderscrolls.bethesda.net/en/morrowind', role: 'creditMorrowind' },
    ],
  },
  {
    title: 'creditsMods',
    entries: [
      { name: 'Tamriel Rebuilt', url: 'https://www.tamriel-rebuilt.org/', role: 'creditTamrielRebuilt' },
      { name: 'Project Tamriel', url: 'https://www.project-tamriel.com/', role: 'creditProjectTamriel' },
      { name: 'Tamriel Data', url: 'https://www.nexusmods.com/morrowind/mods/44537', role: 'creditTamrielData' },
      { name: 'Solstheim Tomb of the Snow Prince', url: 'https://www.nexusmods.com/morrowind/mods/46810', role: 'creditTotsp' },
      { name: 'Wyrmhaven', url: 'https://www.nexusmods.com/morrowind/mods/42933', role: 'creditWyrmhaven' },
      { name: 'White Wolf of Lokken', url: 'https://www.nexusmods.com/morrowind/mods/27306', role: 'creditWhiteWolf' },
      { name: 'Lyithdonea: The Azurian Isles', url: 'https://www.nexusmods.com/morrowind/mods/43749', role: 'creditAzurian' },
      { name: 'OAAB_Data', url: 'https://www.nexusmods.com/morrowind/mods/49042', role: 'creditOaabData' },
      { name: 'Tamriel', url: 'https://www.nexusmods.com/morrowind/mods/58155', role: 'creditTamriel' },
    ],
  },
  {
    title: 'creditsTranslation',
    entries: [
      { name: 'Morrowind', role: 'creditRussianMorrowind', lead: 'creditRussianMorrowindLead' },
      {
        name: 'Tamriel Rebuilt, Project Cyrodiil, Skyrim: Home of the Nords',
        role: 'creditRussianMods',
        lead: 'creditRussianModsLead',
      },
    ],
  },
  {
    title: 'creditsTools',
    entries: [
      { name: 'tes3', url: 'https://github.com/Greatness7/tes3', role: 'creditTes3' },
      { name: 'Leaflet', url: 'https://leafletjs.com/', role: 'creditLeaflet' },
      { name: 'mwmap', url: 'https://github.com/MathisBullinger/mwmap', role: 'creditMwmap', lead: 'creditMwmapLead' },
    ],
  },
]

function creditsDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'credits'

  function fill(): void {
    const heading = document.createElement('h2')
    heading.textContent = t('credits')
    dialog.replaceChildren(heading)

    for (const group of CREDITS) {
      const title = document.createElement('h3')
      title.textContent = t(group.title)
      const list = document.createElement('ul')
      for (const credit of group.entries) {
        const item = document.createElement('li')
        let name: HTMLElement
        if (credit.url) {
          const link = document.createElement('a')
          link.href = credit.url
          link.target = '_blank'
          link.rel = 'noopener'
          name = link
        } else {
          name = document.createElement('strong')
        }
        name.textContent = credit.name
        item.append(credit.lead ? `${t(credit.lead)} ` : '', name, ` ${t(credit.role)}`)
        list.append(item)
      }
      dialog.append(title, list)
    }

    const note = document.createElement('p')
    note.textContent = t('creditsNote')
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = t('close')
    close.addEventListener('click', () => dialog.close())
    dialog.append(note, close)
  }

  fill()
  onLangChange(fill)
  // A click on the dimmed page around the dialog closes it too.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  return dialog
}

/** The line at the bottom of the Map: when the data was built, the author, and the credits. */
export function createFooter(manifest: Manifest): HTMLElement {
  const footer = document.createElement('footer')
  footer.className = 'footer'

  const dialog = creditsDialog()
  const updated = document.createElement('span')
  const credits = document.createElement('button')
  credits.type = 'button'
  credits.addEventListener('click', () => dialog.showModal())

  const source = document.createElement('a')
  source.className = 'footer__link'
  source.href = 'https://github.com/gkalian/morrowind-mods-map'
  source.target = '_blank'
  source.rel = 'noopener noreferrer'
  source.innerHTML = GITHUB_ICON

  function label(): void {
    const date = new Date(manifest.build * 1000).toLocaleDateString(t('dateLocale'), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    updated.textContent = t('updated', { date })
    credits.textContent = t('credits')
    source.title = t('sourceCode')
    source.setAttribute('aria-label', t('sourceCode'))
  }

  label()
  onLangChange(label)
  footer.append(updated, separator(), 'gkalian © 2026', separator(), source, separator(), credits, dialog)
  return footer
}

function separator(): HTMLElement {
  const sep = document.createElement('span')
  sep.className = 'footer__sep'
  sep.setAttribute('aria-hidden', 'true')
  sep.textContent = '|'
  return sep
}

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'
