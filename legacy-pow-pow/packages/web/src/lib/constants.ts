// ─── Name Themes ──────────────────────────────────────────────────────────────

export const NAME_THEMES = {
  'nato-alphabet': ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'],
  'greek-alphabet': ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'],
  gemstones: ['ruby', 'sapphire', 'emerald', 'diamond', 'amethyst', 'topaz', 'opal', 'pearl', 'garnet', 'aquamarine', 'peridot', 'citrine', 'turquoise', 'onyx', 'jade', 'moonstone', 'tanzanite', 'alexandrite', 'spinel', 'zircon'],
  animals: ['fox', 'wolf', 'bear', 'hawk', 'owl', 'raven', 'lion', 'tiger', 'panther', 'falcon', 'eagle', 'badger', 'otter', 'lynx', 'cobra', 'viper', 'phoenix', 'dragon', 'griffin', 'sphinx'],
  cities: ['tokyo', 'paris', 'london', 'berlin', 'rome', 'vienna', 'prague', 'oslo', 'cairo', 'mumbai', 'sydney', 'rio', 'lima', 'athens', 'dublin', 'lisbon', 'seoul', 'bangkok', 'nairobi', 'seattle'],
  colors: ['crimson', 'azure', 'amber', 'jade', 'ivory', 'cobalt', 'scarlet', 'indigo', 'violet', 'coral', 'silver', 'obsidian', 'sage', 'rust', 'navy', 'teal', 'bronze', 'slate', 'olive', 'pearl'],
  trees: ['oak', 'cedar', 'maple', 'pine', 'willow', 'birch', 'cypress', 'sequoia', 'aspen', 'elm', 'spruce', 'redwood', 'juniper', 'magnolia', 'sycamore', 'hemlock', 'hickory', 'beech', 'cherry', 'walnut'],
  dinosaurs: ['rex', 'raptor', 'stego', 'trex', 'bronto', 'ptero', 'trike', 'ankylo', 'diplo', 'allo', 'spino', 'carno', 'pachy', 'thero', 'dilo', 'bary', 'giga', 'utah', 'deinon', 'proto'],
  flowers: ['rose', 'lily', 'iris', 'dahlia', 'orchid', 'tulip', 'jasmine', 'lotus', 'violet', 'poppy', 'aster', 'zinnia', 'peony', 'azalea', 'clover', 'daisy', 'flora', 'ivy', 'fern', 'sage'],
  rappers: ['biggie', 'tupac', 'nas', 'jay', 'em', 'dre', 'snoop', 'cube', 'rakim', 'kane', 'krs', 'ghost', 'method', 'q-tip', 'pos', 'guru', 'premier', 'pac', 'big-l', 'pun'],
  presidents: ['washington', 'lincoln', 'jefferson', 'adams', 'madison', 'monroe', 'jackson', 'grant', 'teddy', 'wilson', 'fdr', 'truman', 'ike', 'jfk', 'lbj', 'reagan', 'clinton', 'obama', 'carter', 'coolidge'],
  beers: ['ipa', 'lager', 'stout', 'porter', 'pilsner', 'ale', 'wheat', 'amber', 'blonde', 'brown', 'bock', 'saison', 'kolsch', 'dunkel', 'hefeweizen', 'tripel', 'dubbel', 'gose', 'sour', 'hazy'],
  grapes: ['merlot', 'shiraz', 'malbec', 'pinot', 'riesling', 'syrah', 'cab', 'zin', 'tempranillo', 'nebbiolo', 'grenache', 'viognier', 'chenin', 'barbera', 'sangiovese', 'verdejo', 'albarino', 'gruner', 'gamay', 'carmenere'],
} as const

export type NameTheme = keyof typeof NAME_THEMES

// ─── Agent State Colors & Labels ──────────────────────────────────────────────

export const STATE_COLORS: Record<string, string> = {
  starting: 'bg-yellow-500',
  idle: 'bg-green-500',
  thinking: 'bg-blue-500 animate-pulse',
  tool_running: 'bg-purple-500 animate-pulse',
  stopped: 'bg-muted-foreground',
  error: 'bg-destructive',
}

export const STATE_LABELS: Record<string, string> = {
  starting: 'Starting...',
  idle: 'Idle',
  thinking: 'Thinking',
  tool_running: 'Running tool',
  stopped: 'Stopped',
  error: 'Error',
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

export const SLASH_COMMANDS = [
  { command: '/summon', description: 'Spawn agents by name', args: '<name1>, <name2>, ...' },
  { command: '/kick', description: 'Remove agents from channel', args: '<name1>, <name2>, ...' },
  { command: '/kick-all', description: 'Remove all agents from channel' },
  { command: '/dismiss', description: 'Dismiss agents (archive but re-summonable)', args: '@agent1, @agent2, ...' },
]
