import type { Manifest } from './manifest'

interface Credit {
  name: string
  url: string
  /** What it is to this Map. */
  role: string
  /** Words that come before the name. */
  lead?: string
}

const CREDITS: { title: string; entries: Credit[] }[] = [
  {
    title: 'Game',
    entries: [
      {
        name: 'The Elder Scrolls III: Morrowind',
        url: 'https://elderscrolls.bethesda.net/en/morrowind',
        role: 'by Bethesda Softworks. The landscape, its textures and every place name of Morrowind and Bloodmoon come from the game.',
      },
    ],
  },
  {
    title: 'Mods',
    entries: [
      {
        name: 'Tamriel Rebuilt',
        url: 'https://www.tamriel-rebuilt.org/',
        role: 'by the Tamriel Rebuilt team: the Morrowind mainland.',
      },
      {
        name: 'Project Tamriel',
        url: 'https://www.project-tamriel.com/',
        role: 'by the Project Tamriel team: Project Cyrodiil and Skyrim: Home of the Nords.',
      },
      {
        name: 'Tamriel Data',
        url: 'https://www.nexusmods.com/morrowind/mods/44537',
        role: 'by the Tamriel Rebuilt and Project Tamriel teams: the textures their lands use.',
      },
      {
        name: 'Tamriel',
        url: 'https://www.nexusmods.com/morrowind/mods/58155',
        role: 'the landmass of the whole continent, drawn where the other mods have no land yet.',
      },
    ],
  },
  {
    title: 'Tools',
    entries: [
      {
        name: 'tes3',
        url: 'https://github.com/Greatness7/tes3',
        role: 'by Greatness7: the library that reads the plugin and archive files.',
      },
      { name: 'Leaflet', url: 'https://leafletjs.com/', role: 'the map viewer.' },
      {
        name: 'mwmap',
        url: 'https://github.com/MathisBullinger/mwmap',
        role: 'by Mathis Bullinger.',
        lead: 'Inspired by',
      },
    ],
  },
]

function creditsDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'credits'

  const heading = document.createElement('h2')
  heading.textContent = 'Credits'
  dialog.append(heading)

  for (const group of CREDITS) {
    const title = document.createElement('h3')
    title.textContent = group.title
    const list = document.createElement('ul')
    for (const credit of group.entries) {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = credit.url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = credit.name
      item.append(credit.lead ? `${credit.lead} ` : '', link, ` ${credit.role}`)
      list.append(item)
    }
    dialog.append(title, list)
  }

  const note = document.createElement('p')
  note.textContent =
    'This is an unofficial fan project, not affiliated with Bethesda Softworks or the mod teams. The map images and place names belong to their authors.'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.addEventListener('click', () => dialog.close())
  dialog.append(note, close)

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

  const updated = new Date(manifest.build * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const dialog = creditsDialog()
  const credits = document.createElement('button')
  credits.type = 'button'
  credits.textContent = 'Credits'
  credits.addEventListener('click', () => dialog.showModal())

  const author = document.createElement('a')
  author.href = 'https://gkalian.com'
  author.target = '_blank'
  author.rel = 'noopener'
  author.textContent = 'gkalian'

  footer.append(`Updated ${updated} | `, author, ' 2026 | ', credits, dialog)
  return footer
}
