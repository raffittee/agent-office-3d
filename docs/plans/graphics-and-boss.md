# Plan: a better-looking office, human agents, and the Boss (Phase 10)

Status: **draft plan, awaiting your answers to the open questions and your go-ahead**. Nothing here is built yet.
Written 2026-11-08; day/night and windows added the same day.

## Goal

Make the office look like a finished product rather than a working prototype, and put you in it:

1. **Graphics and design.** Better lighting, real shadows, more detailed furniture, rooms that read as rooms
   (windows, doors, ceiling lights, signs), a building that sits in a setting, and a cleaner UI. All five themes get
   the upgrade.
2. **Light you can see by, at any hour.** Daytime looks like bright daylight, night is dark outside but easy to read
   inside, and windows catch and reflect the sun as it crosses the sky.
3. **Human agents.** The robots become stylized low-poly people with a varied look (body, skin, hair, outfit,
   accessories) taken from each agent's seed. The robot stays available as a setting.
4. **The Boss.** A new character who stands for you, the user. The Boss has a corner office. They walk over when you
   give an agent work, check on agents that need you, and go home when you're away.

## Where we are today

The [current screenshot](../images/office.png) and the code show what holds the look back:

| Area | Today | Effect |
| --- | --- | --- |
| Lighting | One hemisphere light and one sun, `MeshLambertMaterial` everywhere, `NoToneMapping` (`render3d/scene.ts`) | Flat, evenly lit, a bit washed out |
| Shadows | Blob shadows under characters only | Furniture floats. Nothing grounds the scene |
| Furniture | All procedural boxes (`render3d/kit.ts`). Kenney's kit is in ADR 0004, but no file was ever committed (`ASSETS.md`: "—") | Reads as voxels. Desks, chairs and shelves are hard to tell apart at zoom |
| Rooms | Wall caps, floors and rugs. No windows, door frames, ceiling fixtures or signs | Rooms read as trays. You can't see which project a room is without the labels |
| Setting | Flat grey clear color and a beige ground plane | The building floats in nothing |
| Characters | RobotExpressive (ADR 0005 interim), 1.2 m, one tint slot | Small, all alike apart from color, hard to pick out |
| Post-fx | `postfx` in themes is validated but not drawn | No AO or bloom, even on strong GPUs |
| Day | Flat shading with no tone mapping or shadows, a grey-blue background, and nothing that looks like sunlight indoors. A room with its light off is drawn at 32%, even at noon (`roomBrightness` in `render3d/building.ts`) | Midday reads as an overcast afternoon. Rooms that are arriving or closing look like night |
| Night | Sky light ×0.5 and sun ×0.28 for the whole scene, a near-black background, and dark rooms at 18% | Hard to see anything, characters included |
| Windows | Flat pale-blue panels (`wallItemShape('window')` in `render3d/kit.ts`), one per project room | They don't react to the sun at all |

The budget leaves room for more: 72 draw calls for 38 agents and 6 rooms (`docs/perf.md`), against a cap of 300.

## Decisions (proposed)

| # | Decision | Why |
| --- | --- | --- |
| 1 | **Stylized "diorama" look, not realism.** Soft lighting with tone mapping, real sun shadows, ambient occlusion, rounded and beveled shapes, a restrained palette per theme | It fits D3 (stylized low-poly) and holds up at the isometric zoom. Realism would blow the asset and GPU budgets |
| 2 | **Quality tiers decide the costly effects.** `low`: today's look plus tone mapping. `medium` (default): sun shadows refreshed at about 15 Hz, contact shadows, baked AO. `high`: adds SSAO, bloom on screens, lamps and neon, and SMAA. Theme `postfx` is honored on `high` | Keeps 60 fps on an integrated GPU at `medium` while strong GPUs look better. Needs an ADR, because it changes "postfx not drawn in v1" |
| 3 | **Humans come from Quaternius's Universal Base Characters and Universal Animation Library (CC0),** as ADR 0004 always intended. A new ADR replaces the ADR 0005 interim | They're CC0, low-poly, share one skeleton, and the pipeline (`scripts/assets/`) already knows the animation library |
| 4 | **One material per character, with a palette of up to 6 slots** (skin, hair, top, bottom, shoes, accent) baked into vertex attributes, set per character from its seed | Extends the current `_TINT` mask. Variety without more draw calls or textures |
| 5 | **Themes set a dress code** (an additive `characters` field: outfit weights and palettes). Industrial: flannel and denim. Traditional: shirts and blazers. Startup: hoodies. Modern: smart casual | It's a look, not behavior, so it follows the theme rules |
| 6 | **The Boss lives only in the client.** A pure `client/src/core/boss/` module drives the Boss from snapshot changes, and the renderer draws it like any character. **No protocol or server change** | Everything the Boss needs (a main agent going idle → working, `waiting`, `done`, `statusSince`) is already in `OfficeSnapshot` |
| 7 | **The Boss never changes what an agent's status looks like.** Agents may wave at or turn toward the Boss, but an idle agent never runs back to its desk to look busy | The office has to stay an honest picture of what the agents are doing |
| 8 | **The Boss's identity is local and yours to set:** a name (default "Boss") and a look, in Settings. Stored in `localStorage`, and in the desktop app's settings file. Never filled from your email or account data | Privacy rules. Nothing about you leaves the machine |
| 9 | **The Boss gets a corner office: a new core area,** in every layout template | A fixed home base, like the reception or the kitchen. Templates still produce the same spots |
| 10 | **Readability comes first, at every hour.** Day and night change the mood (color, contrast, what glows), but each has a brightness floor: at night lit rooms stay close to their daytime brightness, rooms with their lights off stay readable, and characters and their markers are clear at any hour | You use the office at night too. A faithful dark office would just be a black screen |
| 11 | **Day and night use exposure, not just dimming.** A pure `exposureAt(ambient)` curve (`core/daylight.ts`) drives the tone mapping exposure, like an eye adjusting: the sky and the outside get darker at night, the exposure comes up, and lamps light the rooms | Dimming every light at once is why night is so dark today. This keeps contrast without losing detail |
| 12 | **Rooms with their lights off are lit by daylight during the day.** The light switch only matters when it's dark outside: by day a dark room loses about 10%, at night it falls to a dim but readable level | An empty room at noon should still look like noon |
| 13 | **Windows are glass that reflects the sky and the sun,** from a small environment map rebuilt from the sky colors whenever the time of day moves on, plus a sun glint that follows the sun's position | Real reflections of the scene (planar or screen-space) are too costly for the budget, and the fixed isometric camera doesn't need them |

## Open questions for you

1. **Where do the human models come from?** The cloud sessions can't reach itch.io, kenney.nl, OpenGameArt or Poly
   Haven (checked today: the proxy refuses all four).
   - **(Recommended)** You run `npm run assets:fetch` once on your machine. Quaternius's Universal Base Characters
     needs a manual itch.io download into `assets-src/`. The fetch pins the SHA-256s, `npm run assets:build` writes
     the committed GLBs, and you push. After that, cloud sessions only need the committed files.
   - Allow `opengameart.org` in this cloud environment. That covers the animation library only, not the bodies.
   - Use KayKit's character packs (CC0, on GitHub). They're reachable from here, but they're fantasy adventurers,
     not office workers.
   - Third-party GitHub mirrors of Quaternius are out: we can't vouch for where those files came from.
2. **Where does the Boss's office go?**
   - **(Recommended)** A new core column next to the lounge: the Boss's office on the north side and a meeting room
     on the south. The building grows by one column (`CORE_COLS` 2 → 3).
   - A glass corner office carved out of the lounge. The building stays the same width, but the lounge shrinks.
3. **How should the Boss know you're "in"?**
   - **(Recommended)** From your prompts (any main agent starting a new turn), plus page visibility and input in the
     browser. In the desktop app, also from the system idle time (Electron `powerMonitor`). It's read on the machine,
     reduced to "here or away", and never sent anywhere.
   - Prompts only.
4. **Should you be able to drive the Boss** (click a spot to walk there, follow-cam)? The plan keeps that as a
   stretch task at the end.
5. **Does the Boss show in the compact widget?** The plan says no: the widget stays a status view.
6. **How dark should night get?** The plan keeps lit rooms at about 85% of their daytime brightness and rooms with
   their lights off at about 45%, while the outside goes deep blue. A "Night brightness" slider in Settings (40–100%)
   lets you tune it. Alternatively, night could be a mood only
   (colors and glowing lamps, no darker at all).

## The Boss

### What the Boss does

A small, pure state machine in `client/src/core/boss/director.ts`. It turns snapshot changes into errands for one
`Character` with `kind: 'boss'`. The sim runs the errands with the same steps (`go`, `sit`, poses, held items) as
everyone else.

| Trigger (from the snapshot) | The Boss… |
| --- | --- |
| Your first activity of the day (or after being away) | arrives by elevator, gets a coffee, sits down in the corner office |
| A main agent goes `idle` → `working` (you just gave it a prompt) | walks to that agent's desk, stands beside it, talks briefly (`talk` pose, speech bubble with an icon, never the prompt text), then goes back |
| An agent is `waiting` | turns toward that room from their desk, and shows a small "!" while anyone is waiting. If it lasts more than 2 minutes, walks over and stands by the raised hand |
| You approve, answer or message from the office (interactive mode) | walks to that agent and gives a thumbs-up or a nod |
| A subagent delivers its result, or all of a session's tasks complete | a nod or a clap from wherever the Boss is |
| Nothing for a while | works at their own desk; now and then refills a coffee or walks a round through the project rooms |
| You've been away for 15 minutes (or the tab is hidden and the system is idle) | turns off the office light and leaves by elevator |

Rules that keep it calm with 30 agents:

- One errand at a time. New triggers go into a queue of at most 3; the newest replaces the oldest, and a room the
  Boss visited in the last 60 s is skipped.
- `waiting` outranks a new prompt, and both outrank wandering.
- The Boss walks a little faster than agents, so visits stay short.
- Agents only react cosmetically: those standing nearby turn toward the Boss and sometimes wave. Seats, desks and
  statuses don't change.

### How the Boss looks

- The same human base as the agents, with a different outfit set (a blazer or a jacket, your pick), a gold badge in
  place of the provider badge, and a gold name label.
- **Settings → Boss:** name, body, skin, hair, outfit, accessories, with a live preview. This delivers the backlog's
  "Character editor" item.
- A "#1 Boss" mug as their coffee cup.

### The corner office

- A new `core:boss` area: an executive desk (`boss_desk`), a chair (`boss_chair`), a sofa, a window wall, a plant, a
  whiteboard and a light switch. On the south side, a meeting room (`meeting_table` already exists).
- New semantic kinds `boss_desk` and `boss_chair` (additive in `FurnitureKind` and `shared/theme.ts`), with procedural
  defaults, so every theme gets them for free and can restyle them.
- `templates.test.ts` keeps checking that every template produces the same spots, now including the Boss's.

## Graphics work

### Renderer and lighting

- Tone mapping (AgX or ACES, picked in a side-by-side test), and a key/fill/rim setup driven by the theme's
  `lighting` and the existing day/night curves.
- Materials: a light `MeshStandardMaterial` profile (fixed roughness per surface preset, no metalness except steel)
  in place of Lambert. Same vertex-color pipeline, so draw calls don't change.
- **Sun shadows:** one directional shadow map fitted to the orthographic view. Characters and tall furniture cast,
  floors and walls receive. The map is redrawn at about 15 Hz, not every frame, and is off on `low`.
- **Contact shadows:** baked dark decals under furniture (part of the merged area mesh, so no extra draw calls), and
  per-vertex AO baked into the procedural kit (inner corners, under desks).
- Background: a sky gradient that follows the time of day, in place of the flat clear color. The ground gets a
  sidewalk, grass, planters and a few trees around the building.
- `high` tier: SSAO, bloom (screens, Edison bulbs, neon), SMAA, through a small pass chain in
  `render3d/postfx.ts`, off unless the tier is `high`.

### Daylight, night and windows

**Why it looks wrong today** (`render3d/scene.ts` `applyDaylight`, `render3d/building.ts`):

- By day, the light is even but flat: soft fill light, a sun that casts no shadows and never reaches inside, no
  tone mapping, and a grey-blue background. Nothing says "sunny". On top of that, a room whose light is off (while it's
  being set up, or after its session ends) is drawn at 32% brightness, even at noon.
- At night, every light is turned down at once (sky light to 50%, the sun to 28% as a bluish moon), the background
  goes near-black, and dark rooms fall to 18%. Nothing makes up for it: lamps are only colors that don't dim, and
  they light nothing around them.
- There's no tone mapping, so there's no way to "adjust the eye" between day and night, and bright areas clip.

**The new day/night model:**

- **Exposure curve.** `exposureAt(ambient)` in `core/daylight.ts` (pure, tested) sets the tone mapping exposure for
  each hour. Day is bright, with crisp shadows. At dusk the light warms and the exposure starts to rise. At night the
  outside is deep blue and the exposure is higher, so interiors stay readable.
- **Brightness floors, tested.** `lightLevelsAt(ambient, roomLight)` returns the brightness of the sky light, the sun
  or moon, the lamps and each room, and the tests pin the floors: at night, a lit room at least 85% and a dark room at
  least 45% of a lit room's daytime brightness. By day, a room with its light off loses only about 10%. The Settings slider scales
  the night values.
- **Lamps that light things.** At night, a lit room's ceiling fixtures and desk lamps cast soft warm pools of light
  onto the floor and desks (additive decals in the merged area mesh, so no extra draw calls). Screens glow onto the
  faces of the agents in front of them. On `high`, a few real point lights per lit room, within budget.
- **Characters always read.** At night characters get a slight rim light and their status markers keep full
  brightness, so a raised hand is never lost in the dark.
- **A sky that matches.** The background gradient and the light colors come from the same day/night keys, so the
  outside, the light and the windows always agree.

**Windows that reflect the sun:**

- Window glass becomes a reflective material (low roughness, Fresnel: more reflective at grazing angles) with an
  environment map made from the current sky gradient and sun. It's a tiny cube map rebuilt (through `PMREMGenerator`)
  only when the ambient changes noticeably, about once a minute, not every frame.
- **Sun glints.** A bright highlight on each window that faces the sun, positioned from `sunAt(hour)`, so it slides
  across the glass as the sun crosses the sky: cool white at midday, gold at dusk, gone at night. On `high`, bloom
  makes it glow.
- **Sunlight coming in.** By day, a patch of sunlight falls on the floor below each window, its angle and length
  following the sun (long and orange in the evening, short at noon), drawn as a soft decal. On `high`, a faint
  light shaft through the air.
- **At night, it turns around.** From outside, the glass of a lit room glows warm. Inside, the glass goes dark and
  shows a faint reflection of the room's lamps.
- Windows on the building's outer walls (P10-06) and the glass partitions of the open-plan templates use the same
  material.
- Everything is driven by the same `Ambient` the rest of day/night uses, so `?hour=18:30` shows a dusk glint in
  screenshots and tests.

### Furniture ("kit v2")

- Rounded and beveled shapes (desk edges, cushions, monitor bezels) in `render3d/kit.ts`, still merged per area.
- More of the details that make a kind recognizable: keyboards and mice, monitor arms, chair casters and backs,
  cables, books with varied spines, mugs, a coffee machine with a carafe, a water cooler with a jug.
- Hero props as small CC0 GLBs, through the `model` mechanism themes already have (`render3d/models.ts`): the
  coffee machine, plants, sofas. That needs either the Kenney kit (same download question as the characters) or
  own-work models built by script, like `scripts/themes/example-models.ts`.
- `/preview.html` gets a before/after toggle.

### Rooms and the building

- Window walls with frames and light coming in, door frames with doors that open as someone passes, baseboards,
  ceiling fixtures you can see in the cutaway, light switches by the doors.
- **Room signs:** the project's name on a plaque by the door and on the wall, drawn into a shared canvas atlas like
  the monitors (`render3d/screens.ts`), so you can tell rooms apart without the floating labels.
- Floor and wall textures for each surface preset (wood grain, carpet, concrete, brick), CC0 and KTX2-compressed.
  This finishes the KTX2 step P3-01 left out. If `toktx` can't be installed, a WASM Basis encoder takes its place.
- The exterior wall: a thicker plinth, windows outside, a roof edge.

### Characters

- Built from the human pack: one skinned mesh, at most ~25 joints (no fingers), at most ~4k triangles, a 25% LOD
  for overview zoom, and quarter-rate animation off screen as today. About 1.7 m tall, so they read at a distance.
- From the seed: body (`info.look` picks f or m), skin tone, hair style and color, outfit, glasses or headphones.
  Subagents keep their lanyard and add a visitor badge, at the same height (shrinking humans makes them look like
  children).
- Animations: Idle, Walk, Run, Sit, Wave, Talk and the rest from the Universal Animation Library. Procedural layers
  (typing, raised hand while seated, sleep) are retuned to human proportions. Blinking eyes, stride-matched walking
  (no foot sliding), turning in place.

### UI

- Design tokens (color, type, spacing, radii) in one place, a dark mode that matches the night lighting, and a
  consistent style across the sidebar, drawer, feed, dialogs and labels.
- Labels and bubbles redrawn to match the scene's palette. A Boss chip in the top bar ("Boss: in office / away").

## Tasks (Phase 10)

Each task is one commit with tests where there's logic, and `npm run typecheck && npm test && npm run build` before
it's ticked. The graphics tasks (02–06) and the Boss tasks (12–16) can start right away on the robot model. The human
character tasks (07–09) wait for P10-01.

- **P10-01 Spike: the human pack** (M) — fetch Universal Base Characters and the Universal Animation Library, list
  bones, clips, triangles and materials, measure 30 of them in the renderer, write `docs/spikes/humans.md` and ADR 0008
  (supersedes the ADR 0005 interim).
- **P10-02 Art direction** (S) — `docs/art-direction.md`: palette rules, light values, material presets, and a fixed
  set of "golden shots" (`npm run shot -- --golden`) so every later task can show before and after.
- **P10-03 Renderer and lighting** (M) — tone mapping, Standard-lite materials, tiered sun shadows, sky gradient,
  quality tiers; ADR 0009 (rendering tiers and post-fx).
- **P10-04 Post-fx on high** (M) — SSAO, bloom, SMAA in `render3d/postfx.ts`; theme `postfx` honored on `high`.
- **P10-05 Kit v2** (L) — beveled shapes, details, baked AO and contact shadows; hero props as models.
- **P10-06 Rooms and the building** (L) — windows, doors, ceiling fixtures, room signs, textures with KTX2,
  exterior and landscaping.
- **P10-07 Human character build** (M) — pipeline entry in `scripts/assets/sources.ts`, profile, palette slots,
  LOD, budget tests in `test/assets.test.ts`.
- **P10-08 Appearance v2** (M) — seed → body, skin, hair, outfit, accessories; theme dress codes (`characters`,
  additive in `shared/theme.ts`); subagent look.
- **P10-09 Animation polish** (M) — library clips mapped, layers retuned, blinking, stride matching.
- **P10-10 Theme refresh** (M) — all five packs updated, thumbnails regenerated, `npm run theme:check`.
- **P10-11 UI polish** (M) — tokens, dark mode, consistent panels and labels.
- **P10-12 The Boss's office** (M) — `core:boss` area in every template, `boss_desk`/`boss_chair` kinds with
  procedural defaults; templates test.
- **P10-13 The Boss's look and settings** (M) — Settings → Boss (editor with preview), saved locally; Boss outfit,
  gold badge and label.
- **P10-14 The Boss director** (L) — `client/src/core/boss/director.ts` (pure): the triggers and rules above, cosmetic
  reactions from agents, new poses `thumbs_up`, `nod` and `clap` (additive in `core/vocab.ts`); tested on a fake clock
  with scripted snapshots.
- **P10-15 Presence** (S) — page visibility and input in the browser; `powerMonitor` idle time through the desktop
  preload (validated IPC, a number only).
- **P10-16 Interactive tie-in** (S) — approve, answer and message from the office send the Boss to that agent.
- **P10-19 Day/night rework** (M, after P10-03) — `exposureAt` and `lightLevelsAt` in `core/daylight.ts` with tested
  brightness floors, daylight in rooms with their lights off, lamp light pools, rim light at night, the Night brightness
  setting; golden shots at 08:00, 13:30, 18:30 and 22:30, and a check in `npm run shot` that their average brightness
  stays within the target range.
- **P10-20 Reflective windows and sunlight** (M, after P10-19) — reflective glass from a sky environment map, sun
  glints that follow `sunAt`, sunlight patches on the floor, lit windows glowing at night; the same material for
  partitions.
- **P10-17 (stretch) Drive the Boss** — click to walk, follow-cam.
- **P10-18 Performance and close** (M) — re-measure `docs/perf.md` (30 agents, 15 rooms, each tier), soak, new README
  screenshot, CHANGELOG, ASSETS, ADR list, CLAUDE.md.

**Exit:** humans by default (the robot as a setting), the Boss in their office reacting to your work, all five themes
updated, day and night both easy to read with windows that catch the sun, golden shots reviewed by you, and at
`medium` at most 300 draw calls for 30 agents and 15 rooms in CI and
60 fps on your integrated GPU.

## Risks

- **Assets are the critical path.** Without the download (open question 1), the human characters can't be built.
  The graphics and Boss work doesn't wait for them.
- **Frame rate on integrated GPUs.** Shadows and humans both cost GPU time, and the cloud renders in software, so only
  your machine can check this. `medium` is designed to fit, `high` is opt-in, and `low` stays as today.
- **The Boss getting annoying.** With many agents a busy Boss is noise. The queue, cooldown and priority rules
  above, plus a "Boss stays in the office" setting, keep it in check.
- **Night still too dark, or too bright, on your screen.** Monitors differ a lot. The brightness floors are measured
  in the screenshots, but the last word is your eyes, so the Night brightness slider is part of the task, not an extra.
- **Layout change.** A third core column moves every project room one column east. Rooms are placed by slot, so the
  sim and the camera fit handle it, but every screenshot and test that assumes two core columns needs updating.
