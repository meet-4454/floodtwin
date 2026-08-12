/* ─────────────────────────────────────────────────────────────────────────────
 * registry.js — THE feature catalogue.
 *
 * One list, two consumers:
 *   • the landing page renders it as the "what this does" grid, so a first-time
 *     visitor sees every capability before they ever open the map;
 *   • the console renders it as the Layers & Features panel, so the same names,
 *     icons and groupings carry through into the tool.
 *
 * This module is PURE DATA — no three.js, no map, no engine imports. That is
 * what lets the landing page ship without pulling the 600 KB renderer into its
 * bundle, and it is what keeps the two surfaces from drifting apart.
 *
 * Behaviour lives in engine/controller.js, keyed by these ids.
 *
 * INDEPENDENCE CONTRACT: toggling any feature may only change that feature's own
 * visibility. No feature dims, hides, or re-modes another. Where two features
 * compete for the same pixels (the x-ray dim, the layer stacking order) the
 * engine reconciles it from the full current state rather than one feature
 * reaching into another's flag.
 * ─────────────────────────────────────────────────────────────────────────── */

export const GROUPS = [
  { id: 'flood',   label: 'Flood dynamics', icon: '🌊', blurb: 'What the water does, hour by hour.' },
  { id: 'network', label: 'Buried networks', icon: '🚰', blurb: 'The storm drains and sewers under the street.' },
  { id: 'context', label: 'City context',    icon: '🏙️', blurb: 'What the water is happening to.' },
  { id: 'view',    label: 'View aids',       icon: '🎛️', blurb: 'How the scene is presented.' },
];

export const FEATURES = [
  {
    id: 'flood',
    group: 'flood',
    icon: '🌊',
    label: 'Surface flood sheet',
    short: 'How deep the water is, everywhere, hour by hour',
    blurb:
      'The water itself, drawn as a moving sheet across the city. Both its height and its colour ' +
      'follow the real depth, so you can see the flood spread, deepen and drain away as you move ' +
      'through the storm.',
    defaultOn: true,
    essential: true,
  },
  {
    id: 'hotspots',
    group: 'flood',
    icon: '📍',
    label: 'Flood hotspots',
    short: 'The worst-hit pockets, ranked and named',
    blurb:
      'Finds the areas taking the most water — judged on both how deep it is and how far it ' +
      'spreads — and marks them in order of severity. Each one is labelled with the locality it ' +
      'is in, so the list reads as places you know rather than map coordinates.',
    defaultOn: true,
  },
  {
    id: 'roads',
    group: 'flood',
    icon: '🛣️',
    label: 'Road passability',
    short: 'Which roads are cut at this moment',
    blurb:
      'Checks the real street network against the flood and highlights the stretches under water: ' +
      'amber where a vehicle can still pass with care, red above 0.30 m where cars stop. It updates ' +
      'as you move through the storm, so you can see a route close and reopen.',
    defaultOn: false,
    zoomHint: 'Needs zoom 13 or closer',
  },

  {
    id: 'drainage',
    group: 'network',
    icon: '🚇',
    label: 'Drainage network (3D)',
    short: '139,798 drains underground, filling in real time',
    blurb:
      'The drainage system drawn as real buried pipes, each one at its true depth below the street. ' +
      'Water stands in every pipe at the depth the model solved for it, so a pipe filled to the top ' +
      'is a drain running at capacity — and you can watch it fill, back up and empty as the storm ' +
      'passes. Storm drains and foul sewers are separated and switchable.',
    defaultOn: false,
    heavy: true,
    children: [
      { id: 'storm',     label: 'Storm conduits',     defaultOn: true,
        hint: '21,910 pipes identified as storm-water drains' },
      { id: 'sewer',     label: 'Sewer conduits',     defaultOn: true,
        hint: '87,606 pipes identified as foul sewer' },
      { id: 'unclass',   label: 'Unclassified',       defaultOn: true,
        hint: 'Modelled, but not matched to a city record — not guessed at' },
      { id: 'trunk',     label: 'Trunk mains',        auto: true, hint: 'Shown at every zoom' },
      { id: 'main',      label: 'Branch mains',       auto: true, hint: 'Resolves from zoom 13.2' },
      { id: 'lateral',   label: 'Laterals',           auto: true, hint: 'Resolves from zoom 15' },
      { id: 'water',     label: 'Water inside pipes', defaultOn: true },
      { id: 'shafts',    label: 'Manhole shafts',     defaultOn: true },
      { id: 'surcharge', label: 'Surcharging nodes',  defaultOn: true },
      { id: 'inlets',    label: 'Side-entry pits',    defaultOn: true, hint: 'Zoom 14.5+' },
      { id: 'outfalls',  label: 'Outfalls',           defaultOn: true },
      { id: 'pumps',     label: 'Storm pumps',        defaultOn: true },
      { id: 'capacity',  label: 'Capacity view',      defaultOn: false,
        hint: 'Recolours the pipes green → red by how close each is to full' },
    ],
  },
  {
    id: 'sewer',
    group: 'network',
    icon: '🧪',
    label: 'Sewerage network',
    short: '1,980 km of recorded sewer mains',
    blurb:
      'Gurugram’s foul-sewer system exactly as the city records it — 1,980 km of surveyed mains with ' +
      'their recorded size, material and depth. Drawn in violet so it is never mistaken for storm ' +
      'water, and shown flat rather than filling: nobody has modelled flow through it, so the map ' +
      'does not pretend to know.',
    defaultOn: false,
  },

  {
    id: 'buildings',
    group: 'context',
    icon: '🏢',
    label: '3D buildings',
    short: 'The city’s buildings, in three dimensions',
    blurb:
      'Raises the buildings out of the map. With the camera tilted they stand in front of the water ' +
      'and the roads the way they would from the street, which makes it far easier to judge what a ' +
      'given depth actually means on the ground.',
    defaultOn: true,
  },
  {
    id: 'assets',
    group: 'context',
    icon: '🏥',
    label: 'Critical assets',
    short: 'Hospitals, schools, fire and police stations',
    blurb:
      'Around 1,300 real places across six categories. Zoomed out they collect into bubbles showing ' +
      'how many are in each area, and clicking one opens it up; zoom in far enough and every ' +
      'building is named. Click any of them to see how deep the water is at its door right now.',
    defaultOn: false,
    children: [
      { id: 'hospital',     label: 'Hospitals',       defaultOn: true },
      { id: 'school',       label: 'Schools',         defaultOn: false },
      { id: 'college',      label: 'Colleges',        defaultOn: false },
      { id: 'fire_station', label: 'Fire stations',   defaultOn: true },
      { id: 'police',       label: 'Police stations', defaultOn: true },
      { id: 'pharmacy',     label: 'Pharmacies',      defaultOn: false },
    ],
  },
  {
    id: 'wards',
    group: 'context',
    icon: '🗺️',
    label: 'Ward boundaries',
    short: 'MCG ward outlines and the district edge',
    blurb:
      'The city’s ward outlines, so results can be read against the administrative area — and the ' +
      'team — responsible for them. The Gurugram district boundary is drawn with them as a solid ' +
      'outer edge, so it is clear where the city’s wards end and the rest of the district begins.',
    defaultOn: true,
  },

  {
    id: 'xray',
    group: 'view',
    icon: '🩻',
    label: 'X-ray basemap',
    short: 'Dim the streets so the underground reads',
    blurb:
      'Fades the streets and labels down while leaving the buildings bright, so the pipes read as ' +
      'being under the city rather than drawn on top of it. Independent of the drainage switch — dim ' +
      'without the pipes, or show the pipes undimmed.',
    defaultOn: false,
    // Lives as a map button (bottom-right), not a sidebar row.
    mapControl: true,
  },
  {
    id: 'terrain',
    group: 'view',
    icon: '⛰️',
    label: 'Tilt & 3D camera',
    short: 'Pitch the camera into a 3D view',
    blurb: 'Pitches the camera so depth, buildings and the buried network are all readable at once.',
    defaultOn: true,
    mapControl: true,
  },
];

export const FEATURE_BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f]));

/** Initial toggle state, flattened to `id` and `id.childId` keys. */
export function defaultState() {
  const s = {};
  for (const f of FEATURES) {
    s[f.id] = !!f.defaultOn;
    for (const c of f.children || []) {
      // `auto` children start unpinned — the engine picks visibility by zoom.
      s[`${f.id}.${c.id}`] = c.auto ? 'auto' : !!c.defaultOn;
    }
  }
  return s;
}

export const featuresInGroup = (gid) => FEATURES.filter((f) => f.group === gid);

/** Rows the sidebar shows. View aids are map buttons, so they are excluded —
 *  the landing page still lists them, because they ARE features. */
export const PANEL_FEATURES = FEATURES.filter((f) => !f.mapControl);
export const PANEL_GROUPS = GROUPS.filter((g) => PANEL_FEATURES.some((f) => f.group === g.id));
export const panelFeaturesInGroup = (gid) => PANEL_FEATURES.filter((f) => f.group === gid);
