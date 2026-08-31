# Amnesiac SWAT Wizards

An XCOM-like tactics prototype: four wizards are dropped into a procedurally
generated city they know **nothing** about — no map, no intel — to find and
eliminate (or subdue and extract) a target, then escape to their anchor stone
before the city's alarm brings the hunt down on them.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # vitest: map invariants, quest solvability, sim rules
```

## Ship it

`npm run build` produces a fully static, self-contained bundle in `dist/`
(~840 KB, relative paths, no server code, no external requests) that runs from
any subpath:

- **itch.io**: zip the *contents* of `dist/` (index.html at the zip root),
  upload as an HTML project, and check "This file will be played in the
  browser". A viewport of ~1280×720 or "click to launch in fullscreen" works
  well.
- **GitHub Pages**: publish `dist/` (e.g. a `gh-pages` branch or an Actions
  workflow running `npm run build`); the relative base means it works under
  `username.github.io/repo-name/` without configuration.

Imported cities persist per browser via localStorage on both hosts.

## Playing

- **Daily Contract**: everyone gets the same city, drop, and contract each day
  (seeded from the date). The debrief scores the run – fewer turns, lower
  alarm, no civilian casualties and no wizards down all pay – and "Copy
  result" puts a shareable summary on your clipboard. Personal bests are
  remembered per day.
- **Seed** drives everything: city, quest, NPCs, clue chain. Same seed = same mission.
- **Shift+click** rallies the whole squad toward a point in one action – each
  wizard walks as far as their AP allows and forms up without stacking.
- **Click a wizard** (or press `1–4`) to select. Click ground to move
  (blue tint = 1 AP, gold = 2 AP). Arm a spell, then click its target.
- **The amnesia is the game**: the map starts black. The target is real and
  placed from turn one, but *you* only hold a shrinking set of candidate
  hideouts (gold outlines). Narrow it down by:
  - **Question** (`Q`) an adjacent calm civilian — clue carriers are seeded
    along the way to the target;
  - **Charm** — works even on panicked civilians, pacifies guards;
  - **Scry** — expensive: reveals the streets around you and keeps only
    candidates along the true bearing of your quarry.
- **Assassinate** contracts may have lookalike decoys — kill the wrong one and
  the city erupts. The identity clue ("wears a grey cloak") marks the real one
  (red ring) once learned.
- **Extract** contracts: `Sleep` the target, **Pick up** (`G`), carry them
  (half speed, no casting) back to the blue anchor zone with the whole squad.
- **Doors have state**: closed doors block sight and count as full cover.
  Click an adjacent closed door to ease it open (free action), or just walk
  through — breached doors stay open, and everyone can see and shoot through
  the opening. NPCs shove doors open too when they chase you.
- **Windows**: most buildings have pale window slots in their shell walls.
  You can see and shoot through them (recon a room before breaching), they
  give half cover to anyone hugging the sill, and any unit can climb through —
  slow (+2 tiles of movement). Climbing through an **intact** window smashes
  it, loudly, once; click an adjacent intact window to **unlatch it silently
  first** (free), and every later climb is quiet. A villain's room is never a
  one-door kill box, for either side.
- **Roofs**: buildings keep their roofs (with ridge lines) until you've seen
  inside – through a window, an open door, or a mirror-peek. Doors and windows
  on the street side are always visible; interior layout, furniture, and
  partition walls stay hidden under the roof until then.
- **Combat readability**: ranged attacks streak across the map as embers
  (crossbow bolts fly dark) and burst into sparks on impact; damage numbers
  and misses float off the target as the hit lands.
- **Reading the street**: wizards are circles, guards are squares, bodyguards
  and rival adepts are diamonds, civilians are small circles. A red **!**
  overhead means they're hunting you, an amber **?** means they're
  investigating; hover any figure to identify them by name and state. Units
  walk their paths instead of teleporting, so you can see who went where.
- **You can see your noise**: every loud event pulses an amber ring showing
  exactly how far the sound carried — anyone inside that ring may have heard.
- **They will come for you**: witnesses of loud magic remember where it came
  from; hostiles who lose your trail investigate the latest commotion, and
  bodyguards with a cold trail fall back to guarding their doorway. Guards who
  only *hear* something through a wall walk over to investigate — they draw
  steel when they *see* a crime.
- **SWAT toolkit**: **Peek** (`P`, free) slides a mirror under an adjacent
  closed door and reports what's inside without opening it. **Breach** (`B`,
  1 AP) kicks the door — every wizard stacked within 3 tiles immediately
  unloads on the nearest visible hostile. **Sunder** (Bram) blows a hole in
  any adjacent wall, window, or door: pick your own entry point, very loudly.
  **Suppress** (Vex) pins a target: −30 aim and half speed for 2 turns.
- **Hide the evidence**: corpses left in the open are found by guards
  (+alarm), and hauling a body in plain sight causes a scene. **Pick up**
  (`G`) works on the dead as well as the sleeping; **Search/Stash** (`V`)
  rifles an adjacent chest for intel — containers hold letters that duplicate
  clue-chain intel — or folds a carried body into it, out of the alarm
  economy for good.
- **Rules of engagement**: the debrief now grades the contract (Ghost / Clean
  hands / Collateral / Butcher) by alarm level and civilian casualties.
- **Cover is directional, XCOM-style**: walls (and closed doors) are full cover
  (−40 to hit), carts and trees are half (−20), and attacking from a side with
  no cover element is a flank (no penalty). Shield badges show each wizard's
  covered sides; while aiming, enemies show their cover against you (red dot =
  flanked), and hovering a target previews the exact hit chance. Units can
  step-out shoot around their own adjacent cover — the preview draws the
  firing line actually used. Guards seek covered firing positions too.
- **Hover previews**: with a wizard selected, hovering ground shows the walk
  path, its AP price, and the cover shields at the destination cell. Movement
  range renders as a warped organic cell mesh (watabou-style), not a grid.
- **Alarm (0–5)** replaces a mission timer: loud magic, witnesses, and bodies
  escalate patrols → reinforcements → a rival adept. Quiet play matters.
- When your active wizard runs dry the next one with AP is selected
  automatically.
- `E` end turn · `C` center on selection · `F` debug-reveal the map ·
  `Esc` disarm spell · drag / `WASD` pan · wheel zoom.

## Raiding a watabou city

**Northchurch**, a real Medieval Fantasy City Generator export, ships bundled —
it's the default city in the menu. To raid your own city from
[watabou's Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator):

1. Generate a city (the menu links straight to the generator), right-click →
   **Export as → JSON** (GeoJSON also works).
2. Drag the downloaded file anywhere onto the menu screen — it appears in the
   City dropdown as "(imported)" and is remembered by your browser
   (localStorage), so each city only needs to be dropped in once.
3. Drop in — the importer auto-scales whatever units the export uses, crops a
   ~120×120-tile raid window around the densest neighborhood, rasterizes
   buildings/roads/rivers/squares/trees into the tactical grid, carves doors
   facing the streets, BSP-partitions interiors into rooms, and guarantees
   every floor tile is reachable. Real quarter names ("Apple Ring") survive
   into the clue text; gameplay district tags (market, docks, slum…) are
   assigned geographically since watabou's names are pure flavor.

The map renders watabou-style — parchment ground, outlined organic building
shapes drawn from the export's actual polygons, road ribbons, ink-wash fog —
while the sim runs on the tile grid underneath (it only surfaces as dots and
rings when choosing where to move or aim). "Procedural" in the City dropdown
uses a built-in seeded fallback generator instead (wobbled street grid,
rowhouse blocks, plaza, districts).

## Architecture

- `src/core/` — seeded RNG, tile grid, A*, shadowcasting FOV, event bus
- `src/map/` — MFCG importer, fallback city generator, rasterizer, building index
- `src/sim/` — headless deterministic mission sim: units, spells, combat,
  guard/civilian AI, alarm, quest generator, knowledge/intel model
- `src/render/` + `src/ui/` — PixiJS renderer and DOM HUD, subscribed to sim events

The sim never touches Pixi or the DOM; tests exercise it headlessly, including
the invariant that every generated clue chain narrows the candidate set to
exactly the target building.
