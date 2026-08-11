/**
 * Commedia code-names for agents — a memorable identity for every running
 * agent ("Caronte hat den Cache übergesetzt", "Gerione hat den Bug
 * eingewickelt"). Orchestrators draw from the `GUIDES` pool (the guides and
 * judges that plan & command), subagents from the wilder `CAST` pool (ferrymen,
 * monsters, sinners and blessed souls alike).
 *
 * Each figure carries a short German `blurb` so the UI can reveal who they are
 * on hover. Reference: Dante Alighieri, „La Divina Commedia" (1320, gemeinfrei).
 */
export interface LoreCharacter {
  name: string
  /** One-line German tooltip: wer ist diese Figur in Dantes Commedia? */
  blurb: string
}

/** The guides and judges — figures that lead, examine and command. */
export const GUIDES: readonly LoreCharacter[] = [
  { name: 'Virgilio', blurb: 'Römischer Dichter und Dantes Führer durch Hölle und Läuterungsberg — die Vernunft.' },
  { name: 'Beatrice', blurb: 'Dantes Jugendliebe; führt ihn durch die Himmelssphären — die göttliche Weisheit.' },
  { name: 'Bernardo', blurb: 'Bernhard von Clairvaux, der letzte Führer zur Gottesschau im Empyreum.' },
  { name: 'Catone', blurb: 'Cato von Utica, strenger Wächter am Fuß des Läuterungsbergs.' },
  { name: 'Minosse', blurb: 'Richter der Hölle; weist jeder Seele mit den Windungen seines Schwanzes ihren Kreis zu.' },
  { name: 'Stazio', blurb: 'Römischer Dichter Statius, geläutert; begleitet Dante durchs obere Purgatorio.' },
  { name: 'Matelda', blurb: 'Hüterin des irdischen Paradieses; taucht Dante in Lethe und Eunoë.' },
  { name: 'Tommaso', blurb: 'Thomas von Aquin; führt den Reigen der Weisen in der Sonnensphäre an.' },
  { name: 'Giustiniano', blurb: 'Kaiser Justinian, der das römische Recht ordnete — Stimme der Merkursphäre.' },
  { name: 'Pietro', blurb: 'Apostel Petrus; prüft Dante im Fixsternhimmel über den Glauben.' },
  { name: 'Cacciaguida', blurb: 'Dantes Urahn im Mars; prophezeit sein Exil und gibt ihm den Schreibauftrag.' },
  { name: 'Lucia', blurb: 'Die heilige Lucia, die Dantes Rettung im Auftrag des Himmels anstößt.' },
  { name: 'Salomone', blurb: 'König Salomo, der Weiseste im Reigen der Sonnensphäre.' },
  { name: 'Benedetto', blurb: 'Der heilige Benedikt in der Saturnsphäre der Kontemplativen.' },
  { name: 'Bonaventura', blurb: 'Franziskanischer Gelehrter; führt den zweiten Reigen der Weisen an.' }
]

/** The wider, wilder cast — ferrymen, monsters, sinners and blessed souls. */
export const CAST: readonly LoreCharacter[] = [
  { name: 'Caronte', blurb: 'Fährmann über den Acheron, mit Augen wie glühende Räder.' },
  { name: 'Cerbero', blurb: 'Dreiköpfiger Höllenhund, Wächter über die Schlemmer.' },
  { name: 'Pluto', blurb: 'Dämon des Reichtums, der „Pape Satàn" kläfft.' },
  { name: 'Flegias', blurb: 'Zorniger Fährmann über den Styx.' },
  { name: 'Minotauro', blurb: 'Der Minotaurus, tobender Wächter der Gewalttätigen.' },
  { name: 'Chirone', blurb: 'Weiser Anführer der Zentauren am Blutstrom.' },
  { name: 'Nesso', blurb: 'Zentaur, der Dante über den Phlegethon trägt.' },
  { name: 'Gerione', blurb: 'Ungeheuer des Betrugs — ehrliches Gesicht, Skorpionschwanz; fliegt Dante hinab.' },
  { name: 'Malacoda', blurb: '„Böser Schwanz", Anführer der Malebranche-Dämonen.' },
  { name: 'Barbariccia', blurb: 'Dämon der Malebranche, führt die groteske Patrouille an.' },
  { name: 'Farfarello', blurb: 'Flatterhafter Dämon aus der Malebranche-Schar.' },
  { name: 'Ciampolo', blurb: 'Gauner aus Navarra, der die Dämonen selbst austrickst.' },
  { name: 'Ulisse', blurb: 'Odysseus; erzählt von der letzten Fahrt hinter die Säulen des Herakles.' },
  { name: 'Ugolino', blurb: 'Graf im Eis des Cocito, der sein furchtbares Schicksal berichtet.' },
  { name: 'Farinata', blurb: 'Stolzer Florentiner, der sich mächtig aus dem Feuergrab erhebt.' },
  { name: 'Brunetto', blurb: 'Brunetto Latini, Dantes alter Lehrer, dem er ehrend begegnet.' },
  { name: 'Francesca', blurb: 'Francesca da Rimini, mit Paolo im ewigen Sturm der Liebenden.' },
  { name: 'Paolo', blurb: 'Paolo Malatesta, schweigend an Francescas Seite im Sturm.' },
  { name: 'Capaneo', blurb: 'Lästerer, der trotzig unter dem Feuerregen liegt.' },
  { name: 'Argenti', blurb: 'Filippo Argenti, der Zornige, der aus dem Styx auffährt.' },
  { name: 'Belacqua', blurb: 'Der Gemütlichste am Fuß des Läuterungsbergs — wartet einfach ab.' },
  { name: 'Casella', blurb: 'Musiker und Freund Dantes, singt am Strand des Purgatorio.' },
  { name: 'Manfredi', blurb: 'König Manfred, blond und schön, in letzter Stunde bekehrt.' },
  { name: 'Sordello', blurb: 'Troubadour, der Virgilio als Landsmann stürmisch umarmt.' },
  { name: 'Oderisi', blurb: 'Buchmaler unter den Stolzen — über die Vergänglichkeit des Ruhms.' },
  { name: 'Forese', blurb: 'Dantes Freund Forese Donati unter den Büßern der Schlemmer.' },
  { name: 'Arnaut', blurb: 'Trobador Arnaut Daniel, der im läuternden Feuer provenzalisch spricht.' },
  { name: 'Piccarda', blurb: 'Erste Seele, die Dante im Mondhimmel begegnet — über die himmlische Ordnung.' },
  { name: 'Romeo', blurb: 'Romeo di Villanova, der treue, verkannte Minister in der Merkursphäre.' },
  { name: 'Folco', blurb: 'Troubadour und späterer Bischof Folquet in der Venussphäre.' },
  { name: 'Trajano', blurb: 'Kaiser Trajan, der gerechte Heide im Auge des Jupiter-Adlers.' },
  { name: 'Rifeo', blurb: 'Rifeus der Trojaner — der überraschendste Gerechte im Paradies.' },
  { name: 'Lucifero', blurb: 'Der dreigesichtige Herrscher des Eises am tiefsten Grund der Hölle.' },
  { name: 'Caco', blurb: 'Zentaur mit feuerspeiendem Drachen auf dem Rücken, jagt die Diebe.' },
  { name: 'Fortuna', blurb: 'Die Glücksgöttin, die als Dienerin Gottes die Güter der Welt dreht.' },
  { name: 'Pia', blurb: 'La Pia aus Siena — sanfte Bitte um Erinnerung im Antipurgatorio.' }
]

const LORE: ReadonlyMap<string, string> = new Map(
  [...GUIDES, ...CAST].map((c) => [c.name, c.blurb])
)

/** Just the names, for the allocator pools. */
export const GUIDE_NAMES: readonly string[] = GUIDES.map((c) => c.name)
export const CAST_NAMES: readonly string[] = CAST.map((c) => c.name)

/**
 * Look up the tooltip text for a code-name. Handles the allocator's numbered
 * fallback (e.g. "Virgilio 2" → Virgilios blurb). Returns undefined for names
 * that are not part of the cast.
 */
export function loreBlurb(name: string): string | undefined {
  if (!name) return undefined
  const direct = LORE.get(name)
  if (direct) return direct
  const base = name.replace(/\s+\d+$/, '')
  return LORE.get(base)
}
