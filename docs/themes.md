# Making a theme

A theme pack changes how the office looks: floors, walls, light, furniture and decoration. It never changes how the
office behaves, so agents sit, walk and wait in the same places in every theme. A pack is a folder under `themes/`
with a `theme.json`, plus any models it uses. You don't need to touch code.

The built-in packs are good examples to copy from:

| Pack | Shows |
| --- | --- |
| `themes/modern/` | The smallest useful pack: a few colors over the defaults. |
| `themes/industrial/` | The `loft` template, brick and concrete, procedural furniture looks, lots of decor. |
| `themes/traditional/` | Cubicle desks, carpet, fluorescent strips, wainscot. |
| `themes/startup/` | The `open-plan` template, neon, room colors used for chairs. |
| `themes/cabin/` | **The example custom pack:** everything below, including two models of its own. |

## 1. Scaffold the pack

```sh
npm run theme:new -- harbour --name "Harbour Office"
# or start from an existing pack's settings:
npm run theme:new -- harbour --name "Harbour Office" --from industrial
```

This creates `themes/harbour/theme.json` with every section filled in, and an empty `models/` folder. The id must be
lowercase letters, digits and dashes, and it must match the folder name.

## 2. Watch it while you edit

```sh
npm run dev
```

Open **http://127.0.0.1:4848/preview.html?theme=harbour**. The preview page puts every furniture kind side by side
on one floor, with your walls, decor and light, and labels each kind (a blue label means the kind is drawn by one of
your models). Drag to move, scroll to zoom, Q/E to turn, F to frame everything.

Every time you save `theme.json`, the preview and any open office tab reload the theme in place. In the office,
pick it under **Settings → Theme**, or open `/?theme=harbour`.

## 3. Edit `theme.json`

Your editor can autocomplete and check the file: it points at `themes/theme.schema.json` through `"$schema"`.
Only `id`, `name`, `schema` (always `1`), `layout.template` and `palette` (`base`, `accent`) are required. Anything
you leave out falls back to the default look. Colors are always `#rrggbb`.

### Layout

```json
"layout": { "template": "corridor", "wallHeight": 2.8 }
```

- `template` arranges the walls, never the furniture:
  - `corridor`: rooms with walls and a door, along a corridor.
  - `open-plan`: glass partitions instead of walls, and openings between neighbouring rooms.
  - `loft`: low dividers instead of walls, and no runner rugs in the corridor. Pair it with tall walls.
- `wallHeight` (2 to 6 m) is the height of the outer walls that stay up. The walls facing the camera are always cut
  down, whatever the height.

### Palette and materials

```json
"palette": { "base": "#2b2b2b", "accent": "#d97a2b", "background": "#2a2826" },
"materials": {
  "floor": { "preset": "concrete", "color": "#9a9993" },
  "wall": { "preset": "brick", "color": "#a8634a" }
}
```

- `palette.background` is the color around the building. `accent` colors neon decor and the neon practicals.
- `materials` styles surfaces: `floor` (project rooms), `corridorFloor`, `coreFloor` (reception and kitchen),
  `loungeFloor`, `restroomFloor`, `wall`, `exteriorWall`, `trim` (skirting and wall tops), `ground` (the plate under
  the building) and `rug` (tints every rug).
- A `preset` picks a pattern drawn without textures: `wood` (planks), `tile` (a checker), `carpet` (carpet tiles),
  `concrete` (slabs), `marble`, `brick` (courses, on walls), or `plain`, `plaster`, `metal`, `glass`. `color` sets
  the base color. Without it, the preset's own color is used. `roughness` is accepted, for future renderers.

### Lighting

```json
"lighting": { "ambient": "#ffe9d0", "ground": "#8a7a68", "ambientIntensity": 2.1, "sun": { "color": "#ffe2b8", "intensity": 1.3 }, "practicals": "edison-bulbs" }
```

`ambient` and `ground` are the sky and floor colors of the soft fill light. `sun` is the directional light. Both
intensities are the values at midday; the renderer scales them through the day and night (`lightLevelsAt`), so don't
bake the time of day into them. The fill sets how dark a shadow is and the sun's intensity how strong it is: a high
`sun.intensity` over a low `ambientIntensity` gives deep, contrasty shadows, the reverse a flat look. The sun casts
real shadows on the medium and high graphics quality (none on low); its direction is fixed by the simulation, not
by the theme.
`practicals` sets the color of bulbs and light strips in your decor: `edison-bulbs` (amber), `fluorescent` (cool
white), `warm`, `neon` (your accent) or `none`. A dark office reads badly from far away, so keep `ambientIntensity`
near 2.

### Furniture

Furniture is keyed by **semantic kind**: `desk`, `desk_back`, `office_chair`, `office_chair_front`, `meeting_table`,
`stool`, `sofa`, `armchair`, `coffee_machine`, `water_cooler`, `bookshelf`, `plant_tall` and so on. The preview page
labels every kind. For each kind you can do one of three things, from least to most work.

1. **Recolor it.** The built-in boxes have *part roles*: `body`, `top` (desk and table tops), `frame` (legs and
   metal), `seat` (upholstery), `accent` (small details like books), `foliage`, `pot` and `screen`. Set them for
   every kind at once with `kit`, or per kind with `colors`:

   ```json
   "kit": { "frame": "#2b2d30", "top": "#a77b4f" },
   "furniture": { "sofa": { "colors": { "seat": "#7a4a2e" } } }
   ```

2. **Pick another built-in look** with `procedural`: `trestle` (wood on steel legs: desks and tables), `cubicle`
   (desks inside partition panels), `pallet` (stacked pallets: tables), `pipe-shelf` (black pipe and boards:
   shelves), `tufted` (buttoned leather: sofas and armchairs), `stool` (any single seat). A look that doesn't fit the
   kind is ignored.

3. **Use your own model.** See step 4.

### Room colors

```json
"roomVariants": [{ "accent": "#ff4f8b", "carpet": "#ffc2d6", "chair": "#ff4f8b" }, { "accent": "#ffb000" }]
```

Each project room picks one entry by its seed, so neighbouring rooms differ and a room keeps its colors. `accent` is
required. `carpet` colors the room's rugs, `wall` its walls, and `desk` and `chair` its desk tops and chairs (these
win over `kit`). Five or six entries are plenty.

### Decor

```json
"decor": [{ "kind": "pipes", "on": "everywhere", "density": 0.6 }, { "kind": "pendant_bulbs", "on": "rooms" }]
```

- On the outer walls that stay up: `pipes`, `beams`, `factory_windows`, `plant_wall`, `neon`, `certificates` and
  `string_lights`. Wall decor leaves whiteboards, signs and windows free.
- Overhead: `pendant_bulbs` (over the desks in rooms) and `fluorescent` strips.
- Along every wall: `wainscot` (a lower panel; `color` sets it).
- `on` is `rooms` (project rooms), `core` (reception, kitchen, lounge, restrooms, corridor) or `everywhere`.
  `density` (0 to 1) sets how much, and `color` overrides the default color.

Decor never touches the floor where people walk.

### Not drawn yet

`postfx` (`bloom`, `ao`) is accepted and validated, but not drawn in this version: it costs too much on integrated
GPUs.

## 4. Add a model (optional)

```json
"furniture": { "plant_tall": { "model": "models/cactus.glb", "scale": 1, "yaw": 0 } }
```

- **Format:** binary glTF (`.glb`) inside the pack folder. Meshopt compression is supported. Keep each model small
  (a few thousand triangles) and use a few plain materials. Textures work, but every texture adds to the pack's size.
- **Orientation:** metres, Y up, and the **front facing +Z** (towards the camera). The front is the side a person
  uses: where they sit, work or take a coffee. The office turns the model for each placement (a `desk_back`, a chair
  facing left…). `yaw` (degrees) corrects a model that faces another way.
- **Size:** the model is scaled uniformly to fill the kind's footprint, centred, standing on the floor. `scale`
  shrinks or grows it from there. Footprints are in tiles of 0.5 m: a `desk` is 2 × 1, a `sofa` 3 × 1, a
  `plant_tall` 1 × 1. The preview page shows them all.
- **Cost:** each model is drawn as one instanced mesh per material, whatever the number of copies.
- **Licenses:** use only CC0 or similarly permissive assets. List every file in `ASSETS.md` (source URL, author,
  license), as the tests check.

The cabin's two models are built by `scripts/themes/example-models.ts` from a few cylinders and boxes. It's a small
template if you'd rather make simple shapes in code than in Blender.

## 5. Check it

```sh
npm run theme:check
```

This validates every pack against the schema, checks that the id matches the folder, that referenced files exist
inside the pack, and that the pack is within 15 MB. CI runs the same check.

## 6. Thumbnail (optional)

The theme picker shows `thumbnail` (a `.png` or `.webp` in the pack). Without one, it draws a swatch from your
colors. To render thumbnails of every pack the way the built-ins have them:

```sh
npm run build && npm run shot -- --thumbs
```

This writes `themes/<id>/thumb.png`. Add `"thumbnail": "thumb.png"` to your `theme.json`.

## 7. Make it the default (optional)

`AGENT_OFFICE_THEME=harbour npm start` sets the theme for every browser that hasn't picked one in Settings.

## Rules

- A theme changes how things look, never how the office behaves. There are no fields for paths, seats or spots, and
  templates only move walls.
- Packs are data: JSON, models and images. No code runs from a pack.
- Every model path stays inside the pack: no `..`, no absolute paths.
