/**
 * Tolkien code-names for agents — a memorable, slightly unhinged identity for
 * every running agent ("Smaug hat den Cache verbrannt", "Kankra hat den Bug
 * eingesponnen"). Orchestrators draw from the `LEADERS` pool (the great powers
 * that plan & command), subagents from the wilder `FELLOWSHIP` pool (heroes,
 * beasts, dragons and villains alike).
 *
 * Each character carries a short German `blurb` so the UI can reveal who they
 * are on hover. Reference: https://de.wikipedia.org/wiki/Figuren_in_Tolkiens_Welt
 */
export interface TolkienCharacter {
  name: string
  /** One-line German tooltip: who is this figure in Tolkiens Welt? */
  blurb: string
}

/** The great powers — Valar, Maiar and kings that plan & command. */
export const LEADERS: readonly TolkienCharacter[] = [
  { name: 'Gandalf', blurb: 'Der graue, später weiße Zauberer (Maia) und Anführer der Ringgemeinschaft.' },
  { name: 'Saruman', blurb: 'Oberhaupt des Zaubererordens, der Isengard beherrschte und der Macht verfiel.' },
  { name: 'Sauron', blurb: 'Der Dunkle Herrscher von Mordor und Schöpfer des Einen Rings.' },
  { name: 'Galadriel', blurb: 'Mächtige Elbenherrin von Lothlórien und Trägerin des Rings Nenya.' },
  { name: 'Elrond', blurb: 'Halbelb und Herr von Bruchtal, Hüter uralten Wissens.' },
  { name: 'Aragorn', blurb: 'Waldläufer und rechtmäßiger König von Gondor, Erbe Isildurs.' },
  { name: 'Manwë', blurb: 'Höchster der Valar, König der Winde und Herr über Arda.' },
  { name: 'Morgoth', blurb: 'Der erste Dunkle Herrscher (Melkor), Ursprung allen Übels in Mittelerde.' },
  { name: 'Fëanor', blurb: 'Genialer, stolzer Noldor-Elb und Schöpfer der drei Silmaril.' },
  { name: 'Thranduil', blurb: 'Elbenkönig des Düsterwalds und Vater von Legolas.' },
  { name: 'Gil-galad', blurb: 'Letzter Hochkönig der Noldor in Mittelerde.' },
  { name: 'Círdan', blurb: 'Der Schiffbauer, uralter Elbenherr der Grauen Anfurten.' },
  { name: 'Théoden', blurb: 'König von Rohan, der sich aus Sarumans Bann befreite.' },
  { name: 'Denethor', blurb: 'Der letzte regierende Truchsess von Gondor.' },
  { name: 'Elendil', blurb: 'Anführer der Númenórer im Exil und Gründer der Königreiche in Mittelerde.' }
]

/** The wider, wilder cast — heroes, beasts, dragons and villains. */
export const FELLOWSHIP: readonly TolkienCharacter[] = [
  { name: 'Frodo', blurb: 'Der Hobbit und Ringträger, der den Einen Ring nach Mordor bringt.' },
  { name: 'Samweis', blurb: 'Frodos treuer Gärtner und Gefährte — das Herz der Ringgemeinschaft.' },
  { name: 'Merry', blurb: 'Hobbit aus dem Auenland und Knappe von Rohan (Meriadoc Brandybock).' },
  { name: 'Pippin', blurb: 'Hobbit und Freund Merrys, später Wächter von Gondor (Peregrin Tuk).' },
  { name: 'Legolas', blurb: 'Elbenprinz des Düsterwalds und meisterhafter Bogenschütze.' },
  { name: 'Gimli', blurb: 'Zwergenkrieger, Sohn Glóins, treuer Gefährte von Legolas.' },
  { name: 'Boromir', blurb: 'Sohn Denethors, tapferer Krieger Gondors, der dem Ring erlag.' },
  { name: 'Faramir', blurb: 'Boromirs jüngerer Bruder und besonnener Hauptmann von Gondor.' },
  { name: 'Éowyn', blurb: 'Schildmaid von Rohan, die den Hexenkönig erschlug.' },
  { name: 'Éomer', blurb: 'Marschall der Reiter von Rohan, später dessen König.' },
  { name: 'Bilbo', blurb: 'Hobbit, der den Ring fand — Held aus „Der Hobbit".' },
  { name: 'Gollum', blurb: 'Vom Ring zerfressenes Wesen, einst der Hobbit Sméagol.' },
  { name: 'Tom Bombadil', blurb: 'Rätselhaftes, uraltes Wesen des Alten Waldes — gegen den Ring immun.' },
  { name: 'Beorn', blurb: 'Gestaltwandler, der sich in einen mächtigen Bären verwandelt.' },
  { name: 'Radagast', blurb: 'Der braune Zauberer, Freund der Tiere und Vögel.' },
  { name: 'Glorfindel', blurb: 'Strahlender Elbenfürst aus Bruchtal, einst Bezwinger eines Balrogs.' },
  { name: 'Baumbart', blurb: 'Ältester der Ents, Hirte der Bäume im Fangorn-Wald.' },
  { name: 'Bard', blurb: 'Bogenschütze aus Thal, der den Drachen Smaug erlegte.' },
  { name: 'Thorin', blurb: 'Zwergenkönig Eichenschild, Anführer der Fahrt zum Erebor.' },
  { name: 'Balin', blurb: 'Weiser Zwerg aus Thorins Gruppe, später Herr von Moria.' },
  { name: 'Dwalin', blurb: 'Kampferprobter Zwerg und Bruder Balins.' },
  { name: 'Smaug', blurb: 'Der gewaltige Drache, der den Erebor und seinen Schatz raubte.' },
  { name: 'Glaurung', blurb: 'Der „Vater der Drachen", erster der Drachen Morgoths.' },
  { name: 'Ancalagon', blurb: 'Ancalagon der Schwarze, größter geflügelter Drache Morgoths.' },
  { name: 'Kankra', blurb: 'Riesige Spinne, die Frodo auf dem Weg nach Mordor überfiel (Shelob).' },
  { name: 'Ungoliant', blurb: 'Uralte Spinnengestalt, die mit Morgoth die Bäume Valinors vernichtete.' },
  { name: 'Durins Fluch', blurb: 'Der Balrog aus Morias Tiefen, den Gandalf bezwang.' },
  { name: 'Hexenkönig', blurb: 'Anführer der neun Nazgûl und Herr von Angmar.' },
  { name: 'Grishnákh', blurb: 'Ork-Hauptmann Mordors, der die Hobbits jagte.' },
  { name: 'Schattenfell', blurb: 'Herr aller Pferde und Gandalfs treuer Hengst (Shadowfax).' },
  { name: 'Gwaihir', blurb: 'Der Windherr, größter der Adler, der Gandalf zweimal rettete.' },
  { name: 'Wurmzunge', blurb: 'Gríma, der falsche Ratgeber Théodens im Dienst Sarumans.' },
  { name: 'Treebeard', blurb: 'Der englische Name Baumbarts, des ältesten Ents.' },
  { name: 'Haldir', blurb: 'Elbischer Grenzwächter von Lothlórien.' },
  { name: 'Beregond', blurb: 'Wache der Zitadelle von Gondor, die Faramir das Leben rettete.' }
]

const LORE: ReadonlyMap<string, string> = new Map(
  [...LEADERS, ...FELLOWSHIP].map((c) => [c.name, c.blurb])
)

/** Just the names, for the allocator pools. */
export const LEADER_NAMES: readonly string[] = LEADERS.map((c) => c.name)
export const FELLOWSHIP_NAMES: readonly string[] = FELLOWSHIP.map((c) => c.name)

/**
 * Look up the tooltip text for a code-name. Handles the allocator's numbered
 * fallback (e.g. "Gandalf 2" → Gandalfs blurb). Returns undefined for names
 * that are not part of the cast.
 */
export function tolkienBlurb(name: string): string | undefined {
  if (!name) return undefined
  const direct = LORE.get(name)
  if (direct) return direct
  const base = name.replace(/\s+\d+$/, '')
  return LORE.get(base)
}
