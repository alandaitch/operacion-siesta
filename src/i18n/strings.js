// UI · every user-visible string in the game, written twice.
//
// APPROACH. One flat table per language, keyed by the conventions in CONTRACTS §12. Flat beats
// nested because every other module emits a dotted key as a *string* ('toast.perfectZone') and a
// flat map is a single hash lookup with no walk and no undefined-chain.
//
// Three things this module does that a plain lookup table does not:
//
//  1. VARS THAT ARE THEMSELVES KEYS. rules.js emits `{ key:'toast.objective', vars:{ name:'obj.shelf' } }`
//     — the variable is a key, not a noun. So interpolation resolves any var whose value is a known
//     key, and localises any var that is a number. Callers never have to know.
//  2. A HUMANISING FALLBACK. A missing key renders as "Sippy cup", not as "prop.sippyCup". Set
//     dressers are writing props in parallel with this file; an unknown label must degrade into
//     something a player can read, while still warning once in the console so it gets fixed.
//  3. LIVE RE-RENDER. setLang() notifies subscribers synchronously, so the HUD and the menus
//     rebuild their text without a reload and without polling.
//
// Spanish is rioplatense — voseo throughout (agarrá, tirá, comé, escondete), and the jokes are
// authored natively in each language rather than translated. English is dry; Spanish shouts.

const EN = {
  // ── identity ────────────────────────────────────────────────────────────────────────────
  'game.title': 'OPERATION NAPTIME',
  'game.titleTop': 'OPERATION',
  'game.titleBottom': 'NAPTIME',
  'game.tagline': 'Ten months old. Three minutes. One living room.',
  'game.location': 'Living room incident · 17:34',

  // ── menus ───────────────────────────────────────────────────────────────────────────────
  'ui.menu.start': 'Begin the incident',
  'ui.menu.resume': 'Resume',
  'ui.menu.restart': 'Start over',
  'ui.menu.settings': 'Settings',
  'ui.menu.controls': 'Controls',
  'ui.menu.credits': 'Credits',
  'ui.menu.quit': 'Back to title',
  'ui.menu.back': 'Back',
  'ui.menu.close': 'Close',
  'ui.menu.paused': 'PAUSED',
  'ui.menu.pausedSub': 'The nap continues without you.',
  'ui.menu.difficulty': 'Nap length',
  'ui.menu.diff.gentle': 'Light sleeper',
  'ui.menu.diff.standard': 'Normal nap',
  'ui.menu.diff.feral': 'Out cold',
  'ui.menu.diff.gentle.note': '3:30 · the parent is slow to worry',
  'ui.menu.diff.standard.note': '3:00 · the way it is meant to be played',
  'ui.menu.diff.feral.note': '2:30 · they are already suspicious',
  'ui.menu.objectives': 'Current objectives',
  'ui.menu.noObjectives': 'Nothing pending. Improvise.',
  'ui.menu.confirmQuitTitle': 'Abandon the incident?',
  'ui.menu.confirmQuitBody': 'The run ends here and the score is not saved.',
  'ui.menu.confirmYes': 'Abandon',
  'ui.menu.confirmNo': 'Keep crawling',

  // ── settings ────────────────────────────────────────────────────────────────────────────
  'ui.set.title': 'SETTINGS',
  'ui.set.group.game': 'Game',
  'ui.set.group.display': 'Display',
  'ui.set.group.audio': 'Audio',
  'ui.set.group.access': 'Comfort & access',
  'ui.set.language': 'Language',
  'ui.set.lang.en': 'English',
  'ui.set.lang.es': 'Español',
  'ui.set.view': 'Camera',
  'ui.set.view.first': 'First person',
  'ui.set.view.third': 'Third person',
  'ui.set.quality': 'Quality',
  'ui.set.quality.auto': 'Auto',
  'ui.set.quality.low': 'Low',
  'ui.set.quality.medium': 'Medium',
  'ui.set.quality.high': 'High',
  'ui.set.quality.ultra': 'Ultra',
  'ui.set.quality.note': 'Detected: {tier}. Some of this only takes hold on a restart.',
  'ui.set.quality.restart': 'Restart now',
  'ui.set.master': 'Master volume',
  'ui.set.music': 'Music',
  'ui.set.sfx': 'Sound effects',
  'ui.set.sensitivity': 'Look sensitivity',
  'ui.set.trackpadSensitivity': 'Trackpad look sensitivity',
  'ui.set.invertY': 'Invert vertical look',
  'ui.set.reducedMotion': 'Reduced motion',
  'ui.set.reducedMotion.note': 'No drifting numbers, no camera sway in menus.',
  'ui.set.subtitles': 'Subtitles for sound cues',
  'ui.set.subtitles.note': 'Prints what you just heard, and where it came from.',
  'ui.set.photosensitive': 'Photosensitivity damping',
  'ui.set.photosensitive.note': 'Softens the detection flash and every screen pulse.',
  'ui.set.on': 'On',
  'ui.set.off': 'Off',
  'ui.set.reset': 'Reset to defaults',
  'ui.set.saved': 'Saved',

  // ── controls ────────────────────────────────────────────────────────────────────────────
  'ui.ctrl.title': 'CONTROLS',
  'ui.ctrl.move': 'Crawl',
  'ui.ctrl.look': 'Look (click and drag)',
  'ui.ctrl.lookSwipe': 'Look (trackpad swipe)',
  'ui.ctrl.lookArrows': 'Look (arrow keys)',
  'ui.ctrl.sprint': 'Scramble',
  'ui.ctrl.push': 'Shove · hold to wind up',
  'ui.ctrl.pull': 'Pull · hold',
  'ui.ctrl.eat': 'Eat · hold',
  'ui.ctrl.climb': 'Climb a ledge',
  'ui.ctrl.view': 'Swap camera',
  'ui.ctrl.objectives': 'Objectives · hold',
  'ui.ctrl.pause': 'Pause',
  'ui.ctrl.menuNav': 'Navigate menus',
  'ui.ctrl.menuSelect': 'Select',
  'ui.ctrl.menuBack': 'Back',
  'ui.ctrl.gamepad': 'A gamepad works everywhere. Left stick crawls, right stick looks.',

  // ── credits ─────────────────────────────────────────────────────────────────────────────
  'ui.credits.title': 'CREDITS',
  'ui.credits.body':
    'Every surface, sound and shard in this room was generated in code. There are no textures on '
    + 'disk, no models, no samples, no fonts. The room is a photograph of a real apartment in '
    + 'Buenos Aires, rebuilt from a written description in maths.',
  'ui.credits.room': 'The room',
  'ui.credits.roomBody': 'Buenos Aires, late afternoon, winter. Modelled from one photograph.',
  'ui.credits.tech': 'Built with',
  'ui.credits.techBody': 'three.js · Rapier · postprocessing · a great deal of trigonometry',
  'ui.credits.thanks': 'With apologies to',
  'ui.credits.thanksBody': 'Every parent who has ever said "it went quiet, that is the worrying part".',

  // ── HUD ─────────────────────────────────────────────────────────────────────────────────
  'ui.hud.chaos': 'Chaos',
  'ui.hud.combo': 'Combo',
  'ui.hud.naptime': 'Naptime',
  'ui.hud.detection': 'Detection',
  'ui.hud.objectives': 'Objectives',
  'ui.hud.stamina': 'Stamina',
  'ui.hud.best': 'Best',
  'ui.hud.record': 'New record',
  'ui.hud.hold': 'Hold',
  'ui.hud.bonus': 'Bonus',
  'ui.hud.zone': 'Zone cleared',
  'ui.hud.wideOpen': 'Clear',
  'ui.hud.heard': 'Heard something',
  'ui.hud.searching': 'Searching',
  'ui.hud.spotted': 'SEEN',
  'ui.hud.catching': 'RUN',
  'ui.hud.timeUp': 'Time',
  'ui.hud.paused': 'Paused',
  'ui.hud.tab': 'Hold TAB',
  'ui.hud.of': 'of',
  'ui.hud.metres': '{n} m',
  'ui.hud.multiplier': '×{n}',

  // ── touch controls (phone in landscape) ─────────────────────────────────────────────────
  'ui.touch.push': 'SHOVE',
  'ui.touch.grab': 'PULL',
  'ui.touch.eat': 'EAT',
  'ui.touch.view': 'VIEW',

  // ── verbs ───────────────────────────────────────────────────────────────────────────────
  'verb.push': 'Shove',
  'verb.pull': 'Pull',
  'verb.eat': 'Eat',
  'verb.climb': 'Climb',
  'verb.none': '',

  // ── objects ─────────────────────────────────────────────────────────────────────────────
  'prop.unknown': 'Something',
  'prop.ledge': 'Ledge',
  'prop.vase': 'Ridged vase',
  'prop.mug': 'Chipped mug',
  'prop.tinyBottle': 'Tiny bottle',
  'prop.book': 'Book',
  'prop.bookStack': 'Stack of books',
  'prop.magazines': 'Magazines',
  'prop.record': 'Record',
  'prop.vinylCrate': 'Crate of vinyl',
  'prop.speaker': 'Bookshelf speaker',
  'prop.artwork': 'Framed print',
  'prop.photoFrame': 'Photo frame',
  'prop.rug': 'Wool rug',
  'prop.laptop': "Somebody's laptop",
  'prop.snackBag': 'Bag of crisps',
  'prop.cushion': 'Navy cushion',
  'prop.cushionRib': 'Ribbed cushion',
  'prop.blanket': 'Blanket',
  'prop.muslin': 'Muslin square',
  'prop.playmat': 'Play mat',
  'prop.playpen': 'Playpen',
  'prop.playGym': 'Play gym',
  'prop.teether': 'Teether ring',
  'prop.plush': 'Plush toy',
  'prop.teddy': 'Teddy bear',
  'prop.bunny': 'Rabbit',
  'prop.mouse': 'Grey mouse',
  'prop.giraffe': 'Giraffe',
  'prop.elephant': 'Hanging elephant',
  'prop.bird': 'Dangling bird',
  'prop.teethingRing': 'Teething ring',
  'prop.rattle': 'Rattle',
  'prop.boardBook': 'Board book',
  'prop.toyBox': 'Red toy box',
  'prop.playMat': 'Play mat',
  'prop.plantSmall': 'Little plant',
  'prop.fallenLeaf': 'Fallen leaf',
  'prop.leaf': 'Leaf',
  'prop.magazine': 'Magazine',
  'prop.vinyl': 'Vinyl record',
  'prop.shelf': 'Shelf',
  'prop.cord': 'Flex',
  'prop.box': 'Box',
  'prop.toy': 'Toy',
  'prop.cup': 'Cup',
  'prop.parent': 'A grown-up',
  'prop.ukulele': 'Toy ukulele',
  'prop.stackingCup': 'Stacking cup',
  'prop.redBox': 'Red box',
  'prop.ring': 'Plastic ring',
  'prop.blocks': 'Wooden blocks',
  'prop.ball': 'Ball',
  'prop.monstera': 'Monstera',
  'prop.plant': 'Houseplant',
  'prop.pot': 'Ceramic pot',
  'prop.soil': 'Potting soil',
  'prop.floorLamp': 'Floor lamp',
  'prop.pendant': 'Bare bulb',
  'prop.bulb': 'Light bulb',
  'prop.curtain': 'Sheer curtain',
  'prop.espresso': 'Espresso machine',
  'prop.portafilter': 'Portafilter',
  'prop.radiator': 'Radiator',
  'prop.coffeeTable': 'Glass table',
  'prop.sideTable': 'Marble side table',
  'prop.ottoman': 'Bouclé ottoman',
  'prop.pouf': 'Pouf',
  'prop.armchair': 'Bouclé armchair',
  'prop.sofa': 'Sofa',
  'prop.rattanChair': 'Rattan chair',
  'prop.remote': 'TV remote',
  'prop.coaster': 'Coaster',
  'prop.crayon': 'Crayon',
  'prop.coin': 'Loose coin',
  'prop.pacifier': 'Pacifier',
  'prop.sock': 'One sock',
  'prop.slipper': 'Slipper',
  'prop.cable': 'Cable',
  'prop.plug': 'Wall plug',
  'prop.tissue': 'Tissue',
  'prop.wipes': 'Pack of wipes',
  'prop.sippyCup': 'Sippy cup',
  'prop.bottle': 'Bottle',
  'prop.marble': 'Marble',
  'prop.button': 'Button',
  'prop.candle': 'Candle',
  'prop.bowl': 'Bowl',
  'prop.tray': 'Tray',
  'prop.basket': 'Basket',
  'prop.dustBunny': 'Dust bunny',
  'prop.keys': 'House keys',
  'prop.coffeeCup': 'Cold coffee',
  'prop.foldedMuslin': 'Folded muslin',
  'prop.babyBottle': 'Baby bottle',

  // ── objects registered by their kebab-case id (FURN's default labelKey is `prop.<id>`) ────
  'prop.pendant-bulb': 'Bare bulb on a cord',
  'prop.floor-lamp': 'Mushroom-dome floor lamp',
  'prop.side-table': 'Marble side table',
  'prop.espresso-machine': 'The espresso machine',
  'prop.playpen-teether': 'Teether ring on the rail',
  'prop.playpen-door': 'The zip door. Your one way out.',
  'prop.coffee-table': 'Glass coffee table',
  'prop.rattan-chair': 'Rattan chair',

  // ── zones ───────────────────────────────────────────────────────────────────────────────
  'zone.shelf': 'the shelf wall',
  'zone.playpen': 'the playpen',
  'zone.sofa': 'the sofa',
  'zone.window': 'the window',
  'zone.lounge': 'the lounge',

  // ── toasts ──────────────────────────────────────────────────────────────────────────────
  'toast.roundStart': 'They are asleep. You have {minutes} minutes.',
  'toast.toppled': 'Down it goes',
  'toast.yanked': 'Yanked',
  'toast.eaten': 'Swallowed',
  'toast.chain': 'Chain reaction',
  'toast.chaos': 'Chaos',
  'toast.discovery': 'First time: {name}',
  'toast.objective': '{name} · +{bonus}',
  'toast.perfectZone': 'Nothing left standing in {zone}',
  'toast.variety': 'Three different crimes in a row',
  'toast.swing': 'The bulb is swinging',
  'toast.survived': 'Nobody came in. Extraordinary.',
  'toast.spit': 'Spat it out',
  'toast.spit.moved': 'You cannot eat and crawl',
  'toast.spit.caught': 'Swallow later',
  'toast.status.waxy': 'Wax. Everywhere.',
  'toast.status.hiccup': 'Hiccups. Terrible timing.',
  'toast.status.sugar': 'Sugar. Full speed.',
  'toast.status.calm': 'Calm. They are less likely to notice you.',
  'toast.newRecord': 'New personal best',
  'toast.playpenOpen': "Door's open. Go make trouble.",

  // ── status effects ──────────────────────────────────────────────────────────────────────
  'status.waxy': 'Waxy',
  'status.hiccup': 'Hiccups',
  'status.sugar': 'Sugar rush',
  'status.calm': 'Pacified',

  // ── objectives ──────────────────────────────────────────────────────────────────────────
  'obj.shelf': 'Clear three things off the shelves',
  'obj.floorSnack': 'Eat something off the floor',
  'obj.pendant': 'Make the bare bulb swing',
  'obj.laptop': 'Get the laptop onto the floor',
  'obj.combo': 'Reach a ×4 combo',
  'obj.silent': 'Ruin three things without being noticed',
  'obj.plant': 'Topple a plant',
  'obj.shatter': 'Break two things properly',
  'obj.toys': 'Evict five toys from the playpen',
  'obj.curtain': 'Pull down a curtain',
  'obj.speakers': 'Both speakers, face down',
  'obj.crawl': 'Crawl {target} metres',
  'obj.eatThree': 'Eat three things you should not',
  'obj.window': 'Two casualties by the window',

  // ── the parent ──────────────────────────────────────────────────────────────────────────
  'parent.bark.what': 'What was that?',
  'parent.bark.hello': 'Hello? Are you up?',
  'parent.bark.no': 'No. No no no.',
  'parent.bark.coming': "I'm coming in.",
  'parent.bark.quiet': 'It has gone very quiet.',
  'parent.bark.found': 'There you are.',
  'parent.bark.gotcha': 'Right. Up you come.',
  'parent.bark.sigh': 'Every single time.',
  'parent.sub.steps': '[footsteps in the hallway]',
  'parent.sub.door': '[a door in the hallway]',
  'parent.sub.sofa': '[the sofa creaks]',
  'parent.sub.lift': '[two enormous hands]',

  // ── subtitles for sound cues ────────────────────────────────────────────────────────────
  'sub.shatter': '[something shatters]',
  'sub.crash': '[a heavy crash]',
  'sub.thud': '[a soft thud]',
  'sub.chew': '[chewing]',
  'sub.hiccup': '[hic]',
  'sub.swing': '[the cord creaks]',
  'sub.parent.suspicious': '[they stop moving]',
  'sub.parent.searching': '[footsteps, getting closer]',
  'sub.parent.spotted': '[a sharp intake of breath]',
  'sub.parent.catching': '[footsteps, fast]',

  // ── tutorial ────────────────────────────────────────────────────────────────────────────
  'tut.crawl': 'WASD to crawl. Drag, swipe or the arrow keys to look.',
  'tut.escape': 'Hold E on the zip door to get out of the playpen.',
  'tut.push': 'Hold SPACE to wind up, let go to shove.',
  'tut.eat': 'Hold F to put something in your mouth.',
  'tut.done': 'That is the whole game. Ruin everything.',

  // ── game over ───────────────────────────────────────────────────────────────────────────
  'end.title.caught': 'CAUGHT',
  'end.title.timeup': 'THEY SLEPT THROUGH IT',
  'end.sub.caught': 'Lifted into the air, mid-crime.',
  'end.sub.timeup': 'The nap ended before anybody walked in.',
  'end.rank': 'Rank',
  'end.rank.angel': 'Certified angel',
  'end.rank.crawler': 'Mere crawler',
  'end.rank.menace': 'Domestic menace',
  'end.rank.gremlin': 'Gremlin, confirmed',
  'end.rank.wrecker': 'Professional wrecker',
  'end.rank.hurricane': 'Category five toddler',
  'end.rank.legend': 'Legend of the living room',
  'end.score': 'Chaos score',
  'end.breakdown': 'Breakdown',
  'end.cat.knockable': 'Toppled',
  'end.cat.pullable': 'Pulled down',
  'end.cat.edible': 'Eaten',
  'end.cat.hazard': 'Genuinely dangerous',
  'end.cat.fragile': 'Shattered',
  'end.bestCombo': 'Best combo',
  'end.completion': 'Room ruined',
  'end.time': 'Time survived',
  'end.distance': 'Crawled',
  'end.eaten': 'Eaten',
  'end.eatenNone': 'Nothing. Suspicious restraint.',
  'end.discoveries': 'First time ever',
  'end.discoveriesNone': 'No new ground.',
  'end.objectives': 'Objectives',
  'end.objectiveBonus': 'Objective bonus',
  'end.zones': 'Zones flattened',
  'end.highScore': 'Personal best',
  'end.newHighScore': 'NEW PERSONAL BEST',
  'end.previousBest': 'Previous: {n}',
  'end.runs': 'Run number {n}',
  'end.retry': 'Again',
  'end.menu': 'Title screen',
  'end.difficulty': 'Nap length',
  'end.props': '{done} of {total}',
  'end.seconds': '{n} s',

  // ── stats overlay ───────────────────────────────────────────────────────────────────────
  'ui.stats.fps': 'fps',
  'ui.stats.frame': 'frame',
  'ui.stats.draws': 'draws',
  'ui.stats.tris': 'tris',
  'ui.stats.programs': 'shaders',
  'ui.stats.tier': 'tier',
};

const ES = {
  // ── identidad ───────────────────────────────────────────────────────────────────────────
  'game.title': 'OPERACIÓN SIESTA',
  'game.titleTop': 'OPERACIÓN',
  'game.titleBottom': 'SIESTA',
  'game.tagline': 'Diez meses. Tres minutos. Un living entero.',
  'game.location': 'Incidente en el living · 17:34',

  // ── menús ───────────────────────────────────────────────────────────────────────────────
  'ui.menu.start': 'Empezar el desastre',
  'ui.menu.resume': 'Seguir',
  'ui.menu.restart': 'Empezar de nuevo',
  'ui.menu.settings': 'Ajustes',
  'ui.menu.controls': 'Controles',
  'ui.menu.credits': 'Créditos',
  'ui.menu.quit': 'Volver al título',
  'ui.menu.back': 'Volver',
  'ui.menu.close': 'Cerrar',
  'ui.menu.paused': 'EN PAUSA',
  'ui.menu.pausedSub': 'La siesta sigue sin vos.',
  'ui.menu.difficulty': 'Cuánto dura la siesta',
  'ui.menu.diff.gentle': 'Sueño liviano',
  'ui.menu.diff.standard': 'Siesta normal',
  'ui.menu.diff.feral': 'Duerme como un tronco',
  'ui.menu.diff.gentle.note': '3:30 · tardan en preocuparse',
  'ui.menu.diff.standard.note': '3:00 · así se juega',
  'ui.menu.diff.feral.note': '2:30 · ya sospechan algo',
  'ui.menu.objectives': 'Objetivos de ahora',
  'ui.menu.noObjectives': 'Nada pendiente. Improvisá.',
  'ui.menu.confirmQuitTitle': '¿Abandonás el operativo?',
  'ui.menu.confirmQuitBody': 'Se termina la partida acá y el puntaje no se guarda.',
  'ui.menu.confirmYes': 'Abandonar',
  'ui.menu.confirmNo': 'Seguir gateando',

  // ── ajustes ─────────────────────────────────────────────────────────────────────────────
  'ui.set.title': 'AJUSTES',
  'ui.set.group.game': 'Juego',
  'ui.set.group.display': 'Imagen',
  'ui.set.group.audio': 'Sonido',
  'ui.set.group.access': 'Comodidad y accesibilidad',
  'ui.set.language': 'Idioma',
  'ui.set.lang.en': 'English',
  'ui.set.lang.es': 'Español',
  'ui.set.view': 'Cámara',
  'ui.set.view.first': 'Primera persona',
  'ui.set.view.third': 'Tercera persona',
  'ui.set.quality': 'Calidad',
  'ui.set.quality.auto': 'Automática',
  'ui.set.quality.low': 'Baja',
  'ui.set.quality.medium': 'Media',
  'ui.set.quality.high': 'Alta',
  'ui.set.quality.ultra': 'Ultra',
  'ui.set.quality.note': 'Detectada: {tier}. Algunas cosas recién se aplican al reiniciar.',
  'ui.set.quality.restart': 'Reiniciar ahora',
  'ui.set.master': 'Volumen general',
  'ui.set.music': 'Música',
  'ui.set.sfx': 'Efectos',
  'ui.set.sensitivity': 'Sensibilidad del mouse',
  'ui.set.trackpadSensitivity': 'Sensibilidad del trackpad',
  'ui.set.invertY': 'Invertir eje vertical',
  'ui.set.reducedMotion': 'Movimiento reducido',
  'ui.set.reducedMotion.note': 'Sin números que vuelan ni cámara que se mueve sola.',
  'ui.set.subtitles': 'Subtítulos de los sonidos',
  'ui.set.subtitles.note': 'Te escribe lo que acabás de escuchar, y de dónde vino.',
  'ui.set.photosensitive': 'Atenuar destellos',
  'ui.set.photosensitive.note': 'Suaviza el flash de detección y todos los pulsos de pantalla.',
  'ui.set.on': 'Sí',
  'ui.set.off': 'No',
  'ui.set.reset': 'Volver a los valores de fábrica',
  'ui.set.saved': 'Guardado',

  // ── controles ───────────────────────────────────────────────────────────────────────────
  'ui.ctrl.title': 'CONTROLES',
  'ui.ctrl.move': 'Gatear',
  'ui.ctrl.look': 'Mirar (clic y arrastrá)',
  'ui.ctrl.lookSwipe': 'Mirar (deslizá en el trackpad)',
  'ui.ctrl.lookArrows': 'Mirar (flechas)',
  'ui.ctrl.sprint': 'Gatear a lo loco',
  'ui.ctrl.push': 'Empujar · mantené para cargar',
  'ui.ctrl.pull': 'Tirar · mantené',
  'ui.ctrl.eat': 'Comer · mantené',
  'ui.ctrl.climb': 'Treparte a algo',
  'ui.ctrl.view': 'Cambiar cámara',
  'ui.ctrl.objectives': 'Objetivos · mantené',
  'ui.ctrl.pause': 'Pausa',
  'ui.ctrl.menuNav': 'Moverte por el menú',
  'ui.ctrl.menuSelect': 'Elegir',
  'ui.ctrl.menuBack': 'Volver',
  'ui.ctrl.gamepad': 'El joystick anda en todos lados. Stick izquierdo gatea, derecho mira.',

  // ── créditos ────────────────────────────────────────────────────────────────────────────
  'ui.credits.title': 'CRÉDITOS',
  'ui.credits.body':
    'Cada superficie, cada sonido y cada esquirla de este cuarto se generan en código. No hay '
    + 'texturas en el disco, ni modelos, ni samples, ni tipografías. El living es una foto real de '
    + 'un departamento de Buenos Aires, reconstruida a partir de una descripción escrita, con '
    + 'pura matemática.',
  'ui.credits.room': 'El living',
  'ui.credits.roomBody': 'Buenos Aires, invierno, media tarde. Modelado a partir de una sola foto.',
  'ui.credits.tech': 'Hecho con',
  'ui.credits.techBody': 'three.js · Rapier · postprocessing · muchísima trigonometría',
  'ui.credits.thanks': 'Perdón a',
  'ui.credits.thanksBody': 'Toda madre y todo padre que dijo alguna vez "se hizo silencio, eso es lo preocupante".',

  // ── HUD ─────────────────────────────────────────────────────────────────────────────────
  'ui.hud.chaos': 'Caos',
  'ui.hud.combo': 'Combo',
  'ui.hud.naptime': 'Siesta',
  'ui.hud.detection': 'Detección',
  'ui.hud.objectives': 'Objetivos',
  'ui.hud.stamina': 'Aguante',
  'ui.hud.best': 'Récord',
  'ui.hud.record': '¡Récord nuevo!',
  'ui.hud.hold': 'Mantené',
  'ui.hud.bonus': 'Bonus',
  'ui.hud.zone': 'Zona arrasada',
  'ui.hud.wideOpen': 'Vía libre',
  'ui.hud.heard': 'Escuchó algo',
  'ui.hud.searching': 'Te está buscando',
  'ui.hud.spotted': '¡TE VIO!',
  'ui.hud.catching': '¡CORRÉ!',
  'ui.hud.timeUp': 'Tiempo',
  'ui.hud.paused': 'Pausa',
  'ui.hud.tab': 'Mantené TAB',
  'ui.hud.of': 'de',
  'ui.hud.metres': '{n} m',
  'ui.hud.multiplier': '×{n}',

  // ── controles táctiles ──────────────────────────────────────────────────────────────────
  'ui.touch.push': 'EMPUJÁ',
  'ui.touch.grab': 'TIRÁ',
  'ui.touch.eat': 'COMÉ',
  'ui.touch.view': 'CÁMARA',

  // ── verbos ──────────────────────────────────────────────────────────────────────────────
  'verb.push': 'Empujá',
  'verb.pull': 'Tirá',
  'verb.eat': 'Comé',
  'verb.climb': 'Trepá',
  'verb.none': '',

  // ── objetos ─────────────────────────────────────────────────────────────────────────────
  'prop.unknown': 'Algo',
  'prop.ledge': 'Escalón',
  'prop.vase': 'Jarrón acanalado',
  'prop.mug': 'Taza despicada',
  'prop.tinyBottle': 'Botellita',
  'prop.book': 'Libro',
  'prop.bookStack': 'Pila de libros',
  'prop.magazines': 'Revistas',
  'prop.record': 'Disco',
  'prop.vinylCrate': 'Cajón de vinilos',
  'prop.speaker': 'Parlante',
  'prop.artwork': 'Cuadro',
  'prop.photoFrame': 'Portarretrato',
  'prop.rug': 'Alfombra de lana',
  'prop.laptop': 'La notebook de alguien',
  'prop.snackBag': 'Paquete de papas',
  'prop.cushion': 'Almohadón azul',
  'prop.cushionRib': 'Almohadón de corderoy',
  'prop.blanket': 'Manta',
  'prop.muslin': 'Trapito de muselina',
  'prop.playmat': 'Alfombra de juego',
  'prop.playpen': 'Corralito',
  'prop.playGym': 'Gimnasio de bebé',
  'prop.teether': 'Mordillo',
  'prop.plush': 'Peluche',
  'prop.teddy': 'Osito',
  'prop.bunny': 'Conejo',
  'prop.mouse': 'Ratón gris',
  'prop.giraffe': 'Jirafa',
  'prop.elephant': 'Elefante colgante',
  'prop.bird': 'Pajarito colgante',
  'prop.teethingRing': 'Aro mordillo',
  'prop.rattle': 'Sonajero',
  'prop.boardBook': 'Librito de cartón',
  'prop.toyBox': 'Caja roja de juguetes',
  'prop.playMat': 'Alfombra de juego',
  'prop.plantSmall': 'Plantita',
  'prop.fallenLeaf': 'Hoja caída',
  'prop.leaf': 'Hoja',
  'prop.magazine': 'Revista',
  'prop.vinyl': 'Vinilo',
  'prop.shelf': 'Estante',
  'prop.cord': 'Cable',
  'prop.box': 'Caja',
  'prop.toy': 'Juguete',
  'prop.cup': 'Vasito',
  'prop.parent': 'Una persona grande',
  'prop.ukulele': 'Ukelele de juguete',
  'prop.stackingCup': 'Vasito apilable',
  'prop.redBox': 'Caja roja',
  'prop.ring': 'Aro de plástico',
  'prop.blocks': 'Bloques de madera',
  'prop.ball': 'Pelota',
  'prop.monstera': 'Costilla de Adán',
  'prop.plant': 'Planta',
  'prop.pot': 'Maceta',
  'prop.soil': 'Tierra',
  'prop.floorLamp': 'Lámpara de pie',
  'prop.pendant': 'Lamparita colgante',
  'prop.bulb': 'Lamparita',
  'prop.curtain': 'Cortina',
  'prop.espresso': 'Cafetera',
  'prop.portafilter': 'Portafiltro',
  'prop.radiator': 'Radiador',
  'prop.coffeeTable': 'Mesa de vidrio',
  'prop.sideTable': 'Mesita de mármol',
  'prop.ottoman': 'Puff largo',
  'prop.pouf': 'Puff redondo',
  'prop.armchair': 'Sillón de bouclé',
  'prop.sofa': 'Sillón',
  'prop.rattanChair': 'Silla de mimbre',
  'prop.remote': 'Control remoto',
  'prop.coaster': 'Posavasos',
  'prop.crayon': 'Crayón',
  'prop.coin': 'Moneda suelta',
  'prop.pacifier': 'Chupete',
  'prop.sock': 'Una media',
  'prop.slipper': 'Pantufla',
  'prop.cable': 'Cable',
  'prop.plug': 'Enchufe',
  'prop.tissue': 'Pañuelito',
  'prop.wipes': 'Toallitas húmedas',
  'prop.sippyCup': 'Vasito con pico',
  'prop.bottle': 'Mamadera',
  'prop.marble': 'Bolita',
  'prop.button': 'Botón',
  'prop.candle': 'Vela',
  'prop.bowl': 'Bowl',
  'prop.tray': 'Bandeja',
  'prop.basket': 'Canasto',
  'prop.dustBunny': 'Pelusa',
  'prop.keys': 'Las llaves de casa',
  'prop.coffeeCup': 'Café frío',
  'prop.foldedMuslin': 'Muselina doblada',
  'prop.babyBottle': 'Mamadera',

  // ── objetos registrados por su id kebab-case (el labelKey por defecto de FURN es `prop.<id>`) ─
  'prop.pendant-bulb': 'Lamparita pelada, colgando de un cable',
  'prop.floor-lamp': 'Lámpara de pie con forma de hongo',
  'prop.side-table': 'Mesita de mármol',
  'prop.espresso-machine': 'La cafetera',
  'prop.playpen-teether': 'Mordillo colgado del riel',
  'prop.playpen-door': 'La puerta con cierre. Tu única salida.',
  'prop.coffee-table': 'Mesa de vidrio',
  'prop.rattan-chair': 'Silla de mimbre',

  // ── zonas ───────────────────────────────────────────────────────────────────────────────
  'zone.shelf': 'la pared de la biblioteca',
  'zone.playpen': 'el corralito',
  'zone.sofa': 'el sillón',
  'zone.window': 'la ventana',
  'zone.lounge': 'el living',

  // ── avisos ──────────────────────────────────────────────────────────────────────────────
  'toast.roundStart': 'Se durmieron. Tenés {minutes} minutos.',
  'toast.toppled': '¡Al piso!',
  'toast.yanked': '¡Tirado!',
  'toast.eaten': '¡Al buche!',
  'toast.chain': '¡Efecto dominó!',
  'toast.chaos': 'Caos',
  'toast.discovery': 'Primera vez: {name}',
  'toast.objective': '{name} · +{bonus}',
  'toast.perfectZone': '¡No quedó nada en pie en {zone}!',
  'toast.variety': '¡Tres fechorías distintas seguidas!',
  'toast.swing': '¡La lamparita se hamaca!',
  'toast.survived': 'No entró nadie. Increíble.',
  'toast.spit': '¡Lo escupiste!',
  'toast.spit.moved': 'No podés comer y gatear a la vez',
  'toast.spit.caught': 'Después lo tragás',
  'toast.status.waxy': '¡Cera por todos lados!',
  'toast.status.hiccup': '¡Hipo! Justo ahora.',
  'toast.status.sugar': '¡Azúcar! A toda velocidad.',
  'toast.status.calm': 'Tranquilo. Ahora cuesta más que te vean.',
  'toast.newRecord': '¡Récord personal!',
  'toast.playpenOpen': 'Se abrió la puerta. A hacer lío.',

  // ── estados ─────────────────────────────────────────────────────────────────────────────
  'status.waxy': 'Encerado',
  'status.hiccup': 'Hipo',
  'status.sugar': 'Azucarado',
  'status.calm': 'Chupeteado',

  // ── objetivos ───────────────────────────────────────────────────────────────────────────
  'obj.shelf': 'Bajá tres cosas de los estantes',
  'obj.floorSnack': 'Comé algo del piso',
  'obj.pendant': 'Hacé hamacar la lamparita',
  'obj.laptop': 'Bajá la notebook al piso',
  'obj.combo': 'Llegá a un combo ×4',
  'obj.silent': 'Arruiná tres cosas sin que te escuchen',
  'obj.plant': 'Volteá una planta',
  'obj.shatter': 'Rompé dos cosas en serio',
  'obj.toys': 'Sacá cinco juguetes del corralito',
  'obj.curtain': 'Bajate una cortina',
  'obj.speakers': 'Los dos parlantes, boca abajo',
  'obj.crawl': 'Gateá {target} metros',
  'obj.eatThree': 'Comé tres cosas que no se comen',
  'obj.window': 'Dos bajas al lado de la ventana',

  // ── mamá/papá ───────────────────────────────────────────────────────────────────────────
  'parent.bark.what': '¿Qué fue eso?',
  'parent.bark.hello': '¿Hola? ¿Te despertaste?',
  'parent.bark.no': 'No. No, no, no.',
  'parent.bark.coming': 'Voy para allá.',
  'parent.bark.quiet': 'Se hizo mucho silencio.',
  'parent.bark.found': 'Ahí estás.',
  'parent.bark.gotcha': 'Listo. Upa.',
  'parent.bark.sigh': 'Todas. Las. Veces.',
  'parent.sub.steps': '[pasos en el pasillo]',
  'parent.sub.door': '[una puerta en el pasillo]',
  'parent.sub.sofa': '[cruje el sillón]',
  'parent.sub.lift': '[dos manos enormes]',

  // ── subtítulos de sonido ────────────────────────────────────────────────────────────────
  'sub.shatter': '[algo se hace pedazos]',
  'sub.crash': '[un golpe fuerte]',
  'sub.thud': '[un golpe sordo]',
  'sub.chew': '[masticando]',
  'sub.hiccup': '[hip]',
  'sub.swing': '[cruje el cable]',
  'sub.parent.suspicious': '[dejan de moverse]',
  'sub.parent.searching': '[pasos, cada vez más cerca]',
  'sub.parent.spotted': '[toman aire de golpe]',
  'sub.parent.catching': '[pasos, rápidos]',

  // ── tutorial ────────────────────────────────────────────────────────────────────────────
  'tut.crawl': 'WASD para gatear. Arrastrá, deslizá o usá las flechas para mirar.',
  'tut.escape': 'Mantené E en la puerta con cierre para salir del corralito.',
  'tut.push': 'Mantené ESPACIO para cargar, soltá para empujar.',
  'tut.eat': 'Mantené F y metételo en la boca.',
  'tut.done': 'Ese es todo el juego. Arruiná todo.',

  // ── final ───────────────────────────────────────────────────────────────────────────────
  'end.title.caught': '¡TE AGARRARON!',
  'end.title.timeup': 'DURMIERON TODA LA SIESTA',
  'end.sub.caught': 'Levantado por el aire, en pleno delito.',
  'end.sub.timeup': 'Se terminó la siesta y no entró nadie.',
  'end.rank': 'Rango',
  'end.rank.angel': 'Angelito de Dios',
  'end.rank.crawler': 'Gateador amateur',
  'end.rank.menace': 'Peligro doméstico',
  'end.rank.gremlin': 'Gremlin confirmado',
  'end.rank.wrecker': 'Demoledor profesional',
  'end.rank.hurricane': 'Huracán categoría bebé',
  'end.rank.legend': 'Leyenda del living',
  'end.score': 'Puntaje de caos',
  'end.breakdown': 'Desglose',
  'end.cat.knockable': 'Volteadas',
  'end.cat.pullable': 'Arrancadas',
  'end.cat.edible': 'Comidas',
  'end.cat.hazard': 'Verdaderamente peligrosas',
  'end.cat.fragile': 'Hechas pedazos',
  'end.bestCombo': 'Mejor combo',
  'end.completion': 'Living arruinado',
  'end.time': 'Tiempo aguantado',
  'end.distance': 'Gateaste',
  'end.eaten': 'Te comiste',
  'end.eatenNone': 'Nada. Qué contención rara.',
  'end.discoveries': 'Primera vez en tu vida',
  'end.discoveriesNone': 'Nada nuevo bajo el sol.',
  'end.objectives': 'Objetivos',
  'end.objectiveBonus': 'Bonus por objetivos',
  'end.zones': 'Zonas arrasadas',
  'end.highScore': 'Récord personal',
  'end.newHighScore': '¡RÉCORD PERSONAL NUEVO!',
  'end.previousBest': 'Anterior: {n}',
  'end.runs': 'Partida número {n}',
  'end.retry': 'Otra vez',
  'end.menu': 'Volver al título',
  'end.difficulty': 'Duración de la siesta',
  'end.props': '{done} de {total}',
  'end.seconds': '{n} s',

  // ── estadísticas ────────────────────────────────────────────────────────────────────────
  'ui.stats.fps': 'fps',
  'ui.stats.frame': 'cuadro',
  'ui.stats.draws': 'draws',
  'ui.stats.tris': 'tris',
  'ui.stats.programs': 'shaders',
  'ui.stats.tier': 'nivel',
};

export const STRINGS = { en: EN, es: ES };

export const LANGUAGES = [
  { id: 'en', labelKey: 'ui.set.lang.en', locale: 'en-GB' },
  { id: 'es', labelKey: 'ui.set.lang.es', locale: 'es-AR' },
];

const LOCALE = { en: 'en-GB', es: 'es-AR' };

/** Keys we have already complained about, so a missing string warns once and not every frame. */
const warned = new Set();

/** "prop.sippyCup" → "Sippy cup". The last resort, so a missing key never renders as a key. */
function humanise(key) {
  const tail = String(key).split('.').pop() || String(key);
  const spaced = tail
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function createI18n(lang) {
  let current = STRINGS[lang] ? lang : 'en';
  const listeners = new Set();

  let numberFmt = new Intl.NumberFormat(LOCALE[current]);
  let decimalFmt = new Intl.NumberFormat(LOCALE[current], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  function table() {
    return STRINGS[current] || EN;
  }

  function has(key) {
    return typeof key === 'string' && (key in table() || key in EN);
  }

  function raw(key) {
    const t = table();
    if (key in t) return t[key];
    if (key in EN) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[i18n] missing "${key}" in ${current} — falling back to en`);
      }
      return EN[key];
    }
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] unknown key "${key}"`);
    }
    return null;
  }

  function number(n) {
    if (!Number.isFinite(n)) return '0';
    return numberFmt.format(Math.round(n));
  }

  function decimal(n) {
    if (!Number.isFinite(n)) return '0';
    return decimalFmt.format(n);
  }

  /** m:ss, always, because a naptime is never longer than an hour. */
  function time(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function t(key, vars) {
    if (!key) return '';
    let s = raw(key);
    if (s === null) s = humanise(key);
    if (!vars) return s;
    for (const k in vars) {
      let v = vars[k];
      // A variable that is itself a key (rules.js passes 'obj.shelf' as {name}) is resolved,
      // and a numeric variable is localised. Everything else is stringified as-is.
      if (typeof v === 'number') v = number(v);
      else if (typeof v === 'string' && v.indexOf('.') > 0 && has(v)) v = t(v);
      s = s.split(`{${k}}`).join(v == null ? '' : String(v));
    }
    return s;
  }

  const api = {
    get lang() {
      return current;
    },
    get locale() {
      return LOCALE[current];
    },
    get languages() {
      return LANGUAGES;
    },
    has,
    t,
    number,
    decimal,
    time,
    /** Percent, 0..1 → "62%". */
    percent(v) {
      return `${Math.round((v || 0) * 100)}%`;
    },
    /** Metres with one decimal, localised separator. */
    metres(v) {
      return t('ui.hud.metres', { n: decimal(v || 0) });
    },
    setLang(l) {
      if (!STRINGS[l] || l === current) return current;
      current = l;
      numberFmt = new Intl.NumberFormat(LOCALE[current]);
      decimalFmt = new Intl.NumberFormat(LOCALE[current], {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      if (typeof document !== 'undefined') document.documentElement.lang = current;
      for (const fn of [...listeners]) {
        try {
          fn(current);
        } catch (err) {
          console.error('[i18n] listener threw', err);
        }
      }
      return current;
    },
    /** Subscribe to language changes; returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  return api;
}

export default STRINGS;
