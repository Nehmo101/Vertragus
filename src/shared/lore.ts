/**
 * Commedia code-names for agents — a memorable identity for every running
 * agent ("Caronte hat den Cache übergesetzt", "Gerione hat den Bug
 * eingewickelt"). Orchestrators draw from the `GUIDES` pool (the guides and
 * judges that plan & command), subagents from the wilder `CAST` pool (ferrymen,
 * monsters, sinners and blessed souls alike).
 *
 * Each figure carries a short `blurb` in BOTH UI languages so the hover card
 * follows the window's locale — the names stay Italian in every language, only
 * the explanation switches. Reference: Dante Alighieri, „La Divina Commedia"
 * (1320, gemeinfrei / public domain).
 */

/** The two languages the UI ships — see `src/renderer/src/i18n`. */
export type BlurbLocale = 'de' | 'en'

export interface LoreCharacter {
  name: string
  /** One-line tooltip per locale: who is this figure in Dante's Commedia? */
  blurb: { de: string; en: string }
}

/** The guides and judges — figures that lead, examine and command. */
export const GUIDES: readonly LoreCharacter[] = [
  {
    name: 'Virgilio',
    blurb: {
      de: 'Römischer Dichter und Dantes Führer durch Hölle und Läuterungsberg — die Vernunft.',
      en: "Roman poet and Dante's guide through Hell and Mount Purgatory — reason itself."
    }
  },
  {
    name: 'Beatrice',
    blurb: {
      de: 'Dantes Jugendliebe; führt ihn durch die Himmelssphären — die göttliche Weisheit.',
      en: "Dante's youthful love; leads him through the heavenly spheres — divine wisdom."
    }
  },
  {
    name: 'Bernardo',
    blurb: {
      de: 'Bernhard von Clairvaux, der letzte Führer zur Gottesschau im Empyreum.',
      en: 'Bernard of Clairvaux, the last guide, towards the vision of God in the Empyrean.'
    }
  },
  {
    name: 'Catone',
    blurb: {
      de: 'Cato von Utica, strenger Wächter am Fuß des Läuterungsbergs.',
      en: 'Cato of Utica, stern warden at the foot of Mount Purgatory.'
    }
  },
  {
    name: 'Minosse',
    blurb: {
      de: 'Richter der Hölle; weist jeder Seele mit den Windungen seines Schwanzes ihren Kreis zu.',
      en: 'Judge of Hell; assigns each soul its circle with the coils of his tail.'
    }
  },
  {
    name: 'Stazio',
    blurb: {
      de: 'Römischer Dichter Statius, geläutert; begleitet Dante durchs obere Purgatorio.',
      en: 'Roman poet Statius, purified; accompanies Dante through upper Purgatory.'
    }
  },
  {
    name: 'Matelda',
    blurb: {
      de: 'Hüterin des irdischen Paradieses; taucht Dante in Lethe und Eunoë.',
      en: 'Keeper of the earthly paradise; immerses Dante in Lethe and Eunoe.'
    }
  },
  {
    name: 'Tommaso',
    blurb: {
      de: 'Thomas von Aquin; führt den Reigen der Weisen in der Sonnensphäre an.',
      en: 'Thomas Aquinas; leads the ring of the wise in the sphere of the Sun.'
    }
  },
  {
    name: 'Giustiniano',
    blurb: {
      de: 'Kaiser Justinian, der das römische Recht ordnete — Stimme der Merkursphäre.',
      en: 'Emperor Justinian, who set Roman law in order — voice of the sphere of Mercury.'
    }
  },
  {
    name: 'Pietro',
    blurb: {
      de: 'Apostel Petrus; prüft Dante im Fixsternhimmel über den Glauben.',
      en: 'The apostle Peter; examines Dante on faith in the Heaven of Fixed Stars.'
    }
  },
  {
    name: 'Cacciaguida',
    blurb: {
      de: 'Dantes Urahn im Mars; prophezeit sein Exil und gibt ihm den Schreibauftrag.',
      en: "Dante's ancestor in Mars; foretells his exile and charges him to write."
    }
  },
  {
    name: 'Lucia',
    blurb: {
      de: 'Die heilige Lucia, die Dantes Rettung im Auftrag des Himmels anstößt.',
      en: "Saint Lucy, who sets Dante's rescue in motion on Heaven's behalf."
    }
  },
  {
    name: 'Salomone',
    blurb: {
      de: 'König Salomo, der Weiseste im Reigen der Sonnensphäre.',
      en: 'King Solomon, the wisest in the ring of the sphere of the Sun.'
    }
  },
  {
    name: 'Benedetto',
    blurb: {
      de: 'Der heilige Benedikt in der Saturnsphäre der Kontemplativen.',
      en: 'Saint Benedict in the Saturn sphere of the contemplatives.'
    }
  },
  {
    name: 'Bonaventura',
    blurb: {
      de: 'Franziskanischer Gelehrter; führt den zweiten Reigen der Weisen an.',
      en: 'Franciscan scholar; leads the second ring of the wise.'
    }
  }
]

/** The wider, wilder cast — ferrymen, monsters, sinners and blessed souls. */
export const CAST: readonly LoreCharacter[] = [
  {
    name: 'Caronte',
    blurb: {
      de: 'Fährmann über den Acheron, mit Augen wie glühende Räder.',
      en: 'Ferryman across the Acheron, with eyes like glowing wheels.'
    }
  },
  {
    name: 'Cerbero',
    blurb: {
      de: 'Dreiköpfiger Höllenhund, Wächter über die Schlemmer.',
      en: 'Three-headed hound of Hell, warden over the gluttons.'
    }
  },
  {
    name: 'Pluto',
    blurb: {
      de: 'Dämon des Reichtums, der „Pape Satàn" kläfft.',
      en: 'Demon of wealth, yapping "Pape Satàn".'
    }
  },
  {
    name: 'Flegias',
    blurb: {
      de: 'Zorniger Fährmann über den Styx.',
      en: 'Wrathful ferryman across the Styx.'
    }
  },
  {
    name: 'Minotauro',
    blurb: {
      de: 'Der Minotaurus, tobender Wächter der Gewalttätigen.',
      en: 'The Minotaur, raging warden of the violent.'
    }
  },
  {
    name: 'Chirone',
    blurb: {
      de: 'Weiser Anführer der Zentauren am Blutstrom.',
      en: 'Wise leader of the centaurs at the river of blood.'
    }
  },
  {
    name: 'Nesso',
    blurb: {
      de: 'Zentaur, der Dante über den Phlegethon trägt.',
      en: 'Centaur who carries Dante across the Phlegethon.'
    }
  },
  {
    name: 'Gerione',
    blurb: {
      de: 'Ungeheuer des Betrugs — ehrliches Gesicht, Skorpionschwanz; fliegt Dante hinab.',
      en: 'Monster of fraud — honest face, scorpion tail; flies Dante down.'
    }
  },
  {
    name: 'Malacoda',
    blurb: {
      de: '„Böser Schwanz", Anführer der Malebranche-Dämonen.',
      en: '"Evil Tail", leader of the Malebranche demons.'
    }
  },
  {
    name: 'Barbariccia',
    blurb: {
      de: 'Dämon der Malebranche, führt die groteske Patrouille an.',
      en: 'Demon of the Malebranche, leading the grotesque patrol.'
    }
  },
  {
    name: 'Farfarello',
    blurb: {
      de: 'Flatterhafter Dämon aus der Malebranche-Schar.',
      en: 'Flighty demon from the Malebranche troop.'
    }
  },
  {
    name: 'Ciampolo',
    blurb: {
      de: 'Gauner aus Navarra, der die Dämonen selbst austrickst.',
      en: 'Trickster from Navarre who outwits the demons themselves.'
    }
  },
  {
    name: 'Ulisse',
    blurb: {
      de: 'Odysseus; erzählt von der letzten Fahrt hinter die Säulen des Herakles.',
      en: 'Odysseus; tells of the last voyage beyond the Pillars of Hercules.'
    }
  },
  {
    name: 'Ugolino',
    blurb: {
      de: 'Graf im Eis des Cocito, der sein furchtbares Schicksal berichtet.',
      en: 'Count in the ice of Cocytus, recounting his terrible fate.'
    }
  },
  {
    name: 'Farinata',
    blurb: {
      de: 'Stolzer Florentiner, der sich mächtig aus dem Feuergrab erhebt.',
      en: 'Proud Florentine rising mightily from his fiery tomb.'
    }
  },
  {
    name: 'Brunetto',
    blurb: {
      de: 'Brunetto Latini, Dantes alter Lehrer, dem er ehrend begegnet.',
      en: "Brunetto Latini, Dante's old teacher, whom he meets with honour."
    }
  },
  {
    name: 'Francesca',
    blurb: {
      de: 'Francesca da Rimini, mit Paolo im ewigen Sturm der Liebenden.',
      en: 'Francesca da Rimini, with Paolo in the eternal storm of the lovers.'
    }
  },
  {
    name: 'Paolo',
    blurb: {
      de: 'Paolo Malatesta, schweigend an Francescas Seite im Sturm.',
      en: "Paolo Malatesta, silent at Francesca's side in the storm."
    }
  },
  {
    name: 'Capaneo',
    blurb: {
      de: 'Lästerer, der trotzig unter dem Feuerregen liegt.',
      en: 'Blasphemer lying defiant beneath the rain of fire.'
    }
  },
  {
    name: 'Argenti',
    blurb: {
      de: 'Filippo Argenti, der Zornige, der aus dem Styx auffährt.',
      en: 'Filippo Argenti, the wrathful one who rears up out of the Styx.'
    }
  },
  {
    name: 'Belacqua',
    blurb: {
      de: 'Der Gemütlichste am Fuß des Läuterungsbergs — wartet einfach ab.',
      en: 'The most easy-going soul at the foot of Mount Purgatory — simply waits.'
    }
  },
  {
    name: 'Casella',
    blurb: {
      de: 'Musiker und Freund Dantes, singt am Strand des Purgatorio.',
      en: 'Musician and friend of Dante, singing on the shore of Purgatory.'
    }
  },
  {
    name: 'Manfredi',
    blurb: {
      de: 'König Manfred, blond und schön, in letzter Stunde bekehrt.',
      en: 'King Manfred, fair and handsome, converted at the last hour.'
    }
  },
  {
    name: 'Sordello',
    blurb: {
      de: 'Troubadour, der Virgilio als Landsmann stürmisch umarmt.',
      en: 'Troubadour who embraces Virgilio impetuously as a countryman.'
    }
  },
  {
    name: 'Oderisi',
    blurb: {
      de: 'Buchmaler unter den Stolzen — über die Vergänglichkeit des Ruhms.',
      en: 'Illuminator among the proud — on the transience of fame.'
    }
  },
  {
    name: 'Forese',
    blurb: {
      de: 'Dantes Freund Forese Donati unter den Büßern der Schlemmer.',
      en: "Dante's friend Forese Donati among the penitent gluttons."
    }
  },
  {
    name: 'Arnaut',
    blurb: {
      de: 'Trobador Arnaut Daniel, der im läuternden Feuer provenzalisch spricht.',
      en: 'Troubadour Arnaut Daniel, speaking Provençal in the refining fire.'
    }
  },
  {
    name: 'Piccarda',
    blurb: {
      de: 'Erste Seele, die Dante im Mondhimmel begegnet — über die himmlische Ordnung.',
      en: 'First soul Dante meets in the Heaven of the Moon — on the heavenly order.'
    }
  },
  {
    name: 'Romeo',
    blurb: {
      de: 'Romeo di Villanova, der treue, verkannte Minister in der Merkursphäre.',
      en: 'Romeo di Villanova, the loyal, misjudged minister in the sphere of Mercury.'
    }
  },
  {
    name: 'Folco',
    blurb: {
      de: 'Troubadour und späterer Bischof Folquet in der Venussphäre.',
      en: 'Troubadour and later bishop Folquet in the sphere of Venus.'
    }
  },
  {
    name: 'Trajano',
    blurb: {
      de: 'Kaiser Trajan, der gerechte Heide im Auge des Jupiter-Adlers.',
      en: "Emperor Trajan, the just pagan in the eye of Jupiter's eagle."
    }
  },
  {
    name: 'Rifeo',
    blurb: {
      de: 'Rifeus der Trojaner — der überraschendste Gerechte im Paradies.',
      en: 'Ripheus the Trojan — the most surprising of the just in Paradise.'
    }
  },
  {
    name: 'Lucifero',
    blurb: {
      de: 'Der dreigesichtige Herrscher des Eises am tiefsten Grund der Hölle.',
      en: 'The three-faced ruler of the ice at the deepest pit of Hell.'
    }
  },
  {
    name: 'Caco',
    blurb: {
      de: 'Zentaur mit feuerspeiendem Drachen auf dem Rücken, jagt die Diebe.',
      en: 'Centaur with a fire-breathing dragon on his back, hunting the thieves.'
    }
  },
  {
    name: 'Fortuna',
    blurb: {
      de: 'Die Glücksgöttin, die als Dienerin Gottes die Güter der Welt dreht.',
      en: "The goddess of fortune, turning the world's goods as God's servant."
    }
  },
  {
    name: 'Pia',
    blurb: {
      de: 'La Pia aus Siena — sanfte Bitte um Erinnerung im Antipurgatorio.',
      en: 'La Pia of Siena — a gentle plea for remembrance in Antepurgatory.'
    }
  }
]

const LORE: ReadonlyMap<string, LoreCharacter['blurb']> = new Map(
  [...GUIDES, ...CAST].map((c) => [c.name, c.blurb])
)

/** Just the names, for the allocator pools. */
export const GUIDE_NAMES: readonly string[] = GUIDES.map((c) => c.name)
export const CAST_NAMES: readonly string[] = CAST.map((c) => c.name)

/**
 * Look up the tooltip text for a code-name in one UI language. Handles the
 * allocator's numbered fallback (e.g. "Virgilio 2" → Virgilio's blurb).
 * Returns undefined for names that are not part of the cast.
 */
export function loreBlurb(name: string, locale: BlurbLocale): string | undefined {
  if (!name) return undefined
  const direct = LORE.get(name)
  if (direct) return direct[locale]
  const base = name.replace(/\s+\d+$/, '')
  return LORE.get(base)?.[locale]
}
