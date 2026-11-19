# Arcane Study（魔法书斋）· dsh-screensaver theme

An HD-2D theme for [dsh-screensaver](https://github.com/realRoc/dsh-screensaver). While nothing is running, a knight
reads at a desk in a tower study, lit by a crystal full moon through a tall window. As soon as one of your Claude Code,
Codex or DeepSeek Harness sessions starts running, the camera dives into the open book, a rune portal opens, and the
knight climbs the spiral book stairs of the tower. When everything has finished (after a 15 s grace period) a book flies
up to the camera, opens, and you are back in the study.

Every few seconds he turns a page with his right hand: he pinches the corner, carries the page over the spine and
presses it flat, and the 3D page follows his hand frame by frame. The desk, the armchair and the desk props are modelled
in Blender like the knight and shaded with the same palette ramps, the knight sprite carries per-pixel depth so his
hands rest on the book and his legs sit under the desk, and the study renders at about 520 lines so the desk and the
knight share one pixel size.

The interface follows the same layout as the shell and the Subspace Jump theme, drawn in the tower's style:

- **Left, session ledger**: a moonlit glass page with gold corners. Each session has a rune ring around its product
  icon: blue and turning while it runs, amber and breathing when it needs you, a closed gold ring when done, a broken
  crimson ring when stopped. Running sessions have a thread of light under them; the current step fades in like fresh
  ink. The footer counts done / stopped sessions and how long this climb took.
- **Top right, status bar**: battery as a mana vial (crimson at 20% and below), Wi-Fi, tonight's real moon phase, and
  the date and time, where the menu bar would be.
- **Bottom centre, Touch ID**: a rune circle around the system fingerprint icon. Touching the sensor lights it gold when
  recognized and crimson with "The Seal Does Not Match. Touch Again" when not. The hint underneath reads "Enter the
  Moonlit Study · Touch ID or Enter Password", "Starlight Awakens…" while verifying, and "The Glintstone Fades · …"
  with the reason when unlocking fails.
- **Wording**: the interface speaks in the study's voice: "The Stars Keep Vigil" while agents run, "The Spell Unfolds",
  "Awaiting Your Command", "The Tome Is Complete" and "The Spell Is Broken" for the four statuses, "The Tomes Lie
  Still" when everything is done. Known step templates are reworded too ("Read x" → "Consulting the Archives · x");
  file names and commands stay as they are.

The theme sets `"hud": true` in `saver.json`, so the shell hands it the status bar and hint. With an older
dsh-screensaver the shell keeps drawing its own and the theme only shows the scene and the session ledger.

「魔法书斋」：没有任务在跑时，塔顶书房里骑士在月光下读书，长窗外一轮晶莹的满月；有 Claude Code、Codex 或 DeepSeek Harness 会话开始跑，
镜头扎进书页、穿过符文传送门进塔，骑士沿螺旋书阶上行；全部结束（宽限 15 秒）一本书飞到镜头前打开，回到书房。
左侧「此夜纪事」列出每个会话（法印环：蓝色转动是「术式流转」、琥珀色是「静候谕令」、金色闭环是「秘卷既成」、红色断环是「术式中断」，有任务在跑时标题是「群星未眠」），右上角是法力药瓶样式的电池、Wi-Fi、
今晚真实的月相和日期时间，中间下方是套在系统指纹图标外面的法阵：认出来亮金色，没认出来变红并提示「指印未合，再触一次」；底部提示是「月下入阁 · 使用触控 ID 或输入密码」，验证时「星辉渐明…」。
位置和外壳、亚空间主题一样。本主题是视觉作品，采用 CC BY-NC-SA 4.0，禁止商用。

Ships inside [dsh-screensaver](../../README.md) (0.4.0 and later); nothing else to install:

```bash
dsh plugin --profile web add dsh-screensaver
```

Then `/screensaver magic-tower`, or set `theme: magic-tower` in the dsh-screensaver config.

- Up to 60 fps on the main display; 30 fps and a lower resolution on battery and on secondary displays (scene only).
- After 30 s without input (pure mode) the ledger, status bar, hint and seal fade out, like every theme.
- Open `index.html#demo` in a browser to watch a scripted demo; press D for the demo panel (add sessions, finish them,
  simulate Touch ID). `index.html?lang=en#demo` for English. The demo hides the interface after 30 s without input
  too; `#demo,nopure` keeps it on (used to record the README GIFs).
- Built to the rules in [skills/dsh-screensaver-theme](../../skills/dsh-screensaver-theme/SKILL.md).

## Instrument effects

The magic in the tower is a set of effects meant to be driven by music: each instrument of a track maps to one effect
(`INSTRUMENT_FX` in [src/score.js](src/score.js)). Without a score, as in the screen saver, the tower picks at random
every 6–11 s between short phrases built from these effects and the three big events (the sword of light, the comet
volley, the starlight pulse). It never repeats the last pick and never plays two big events in a row, so the effects
vary without piling up.

| Effect | Instrument | What you see |
|---|---|---|
| `beam` | kick | a column of light strikes down from the top of the tower; a shockwave and sparks where it lands |
| `sigil` | snare, clap | a three-tier magic circle lying flat in the well, drawn top to bottom, then shattering |
| `glitter` | hi-hat, shaker | a small cluster of cross-shaped glints (local only, never a full-screen flash) |
| `ripple` | bass | a ring of runes sweeps up the book walls of the whole tower |
| `aurora` | pad, strings, choir | one aurora ribbon per note: it grows in on the attack, holds while the note is held, retracts and drifts up on release |
| `comet` | lead | a comet across the well; the higher the note, the higher it lands |
| `chime` | arp, bell, pluck | a light runs along the railing and lamps flare as it passes |
| `swell` / `slash` / `shower` | crash / section downbeat / fill | the armillary pulse, the giant light sword, a comet salvo |

Pitch has one meaning across all of them: low notes sit lower in the tower and are bigger, slower and deep blue-violet;
high notes sit higher and are smaller, faster, cyan-white to gold. Full-screen brightening (flash light and bloom) is
capped at three times per second whatever the score asks for, and with reduced motion turned on the camera does not
shake and flashes are dimmer.

A score is plain data: tempo, an optional offset and loop, and per track the instrument (or an explicit `fx`) and its
notes as beats, with optional velocity `v`, pitch `p` (0..1 or a MIDI note number) and length `d` in beats:

```js
{ bpm: 112, loopBeats: 32, tracks: [
  { instrument: 'kick', notes: [0, 1, 2, 3] },
  { instrument: 'pad', notes: [{ b: 0, d: 7, p: 48 }, { b: 0.5, d: 6.5, p: 55 }] },
] }
```

`magicTower.fx` exposes `trigger(name, { v, p, d })` (velocity 0..1, pitch 0..1 or a MIDI note, length `d` in **seconds**), `play(score)`, `stop()` (stops a score or the gallery and drops queued effects) and `gallery()`. In the browser,
`index.html#demo,fxgallery` plays every effect from low to high with its name on screen, and `index.html#demo,groove`
plays an 8-bar demo score (`DEMO_SCORE`).

A score may also list `sections` (`{ name, b, mood }`); while it plays, the tower follows the mood of the current
section: how fast the knight climbs, how bright the lamps are and how far every effect leans towards gold (`MOODS` in
`src/scene.js`: `calm`, `walk`, `climb`, `hush`, `full`, `freeze`, `gold`). `play(score, { clock })` follows an outside clock,
such as the playback position of an audio file, instead of the tower's own. Effects with a wind-up (`slash`, `swell`)
start early by `FX_LEAD` seconds so the blow lands on the beat.

## Original BGM: Star Well

[music/](music/) holds *Star Well* (星井), an original 85-second loop written for the climb. It is quiet, mysterious and
unhurried, with no drum kit: a slow waltz in 3/4 at ♩ = 72 in D minor. Its colour comes from chords that never quite land: B♭maj7,
the Neapolitan E♭maj7♯11, and A7sus4 at the end of every phrase, so the loop runs back into the intro in one breath. A
celesta plays a Shepard arpeggio all the way through: each note is the next chord tone above the last, sounding in
several octaves at once with the loudest in the middle register, so it keeps climbing without ever reaching the top.

The piece is built around the dive into the tower, which is its first climax:

1. **Intro and build (in the study).** A two-bar build (Gm9 → A7♭9, a timpani roll and a harp glissando) leads to
   the climax.
2. **Rise.** The dominant resolves deceptively onto B♭maj7 as the book's light bursts and the camera dives in. The
   bass then rises a step a bar while strings, flute and choir push the motif up to its peak, where the sword of light
   strikes.
3. **A section.** The music settles into the flute's motif, which leaps up a fifth and steps back down.
4. **Breath.** A D pedal and a single pulse of light.
5. **A′ section.** The motif returns, with a second sword on its first beat.

[music/song.mjs](music/song.mjs) is the song itself. `node music/build.mjs` turns it into a multitrack MIDI file, the audio (a
seamless loop, and a full version that ends on D minor) and the effect score (`music/out/star-well.score.json`).
Rendering needs `fluidsynth`, `ffmpeg` and a General MIDI SoundFont (GeneralUser GS by default, `SOUNDFONT=` to
change); `--stems` also writes one WAV per track.

The effect score is picked from the music, not note for note, so the picture is only as busy as the song (under two
effects a second):

| Music | Effect |
| --- | --- |
| Each melody note | A comet |
| First note of the Shepard arpeggio | A lamp chain (twice a bar in the rise) |
| Harp bass | A ground ripple |
| Chord changes in the intro, the rise and the breath | One faint aurora |
| Top of the rise, and the return of the motif | The sword of light |
| Start of the breath | A starlight pulse |

Sections change only the lamps (brighter in the rise, dimmer and warmer in the breath). The knight keeps the same pace
throughout, and the camera follows from a step behind and above, with him small on the left of a wide view up the tower.

`index.html#demo,bgm` plays the loop with the effects driven by the audio's playback position (click once to allow
sound, press M to pause). If the audio cannot load, the effects play silently on the tower's clock. The screen saver
itself plays no sound and picks its effect phrases at random.

The sword of light strikes from the centre of the tower's top opening. When it appears, its hilt is fixed on the
tower's axis, 14 above the camera. The blade appears slanting into the side of the frame and chops down until it is
nearly vertical. As it lands, a shockwave sweeps out from the axis across the well to the railing, followed by a
slower second ring.

The camera turns towards the sword in two steps:
1. Over 1.4 s, with the move easing in and out, it tilts up as far as it can while the knight stays in the frame. The
   knight's body has to stay clear of the side and bottom edges, and his feet stay above the bottom edge.
2. It then turns towards the axis within the same limits.

It holds through the strike and returns to the knight over 1.8 s. The camera only turns: it doesn't move or zoom. The
same happens in the screen saver. `FX_LEAD` starts the sword early enough for the strike to land on the beat.

### Record a video

```bash
npm run build
node music/record.mjs                      # 3:4 1080×1440, 92 s → music/out/star-well-3x4.mp4
node music/record.mjs --size 1920x1080     # 16:9
node music/record.mjs --still 20,45,58     # PNG stills of those moments
```

The recorder opens `index.html#demo,bgm,record` in headless Chrome and steps it one frame at a time, so picture and
music line up exactly however slow the machine is. It then muxes in the full mix. The video:
- starts in the study through the intro and the build;
- dives into the book at 13.65 s, so the page burst lands on the first beat of the rise (15 s);
- flies back to the study after the closing D minor chord. It needs Google Chrome, `ffmpeg` and `npm install` (for `playwright-core`).

## Develop

```bash
npm install
npm run build      # rebuilds index.html from src/ and assets/ (commit index.html)
npm run demo
```

`src/scene.js` and `src/study.js` are the scene, `src/hud.js` the interface, `src/main.js` ties sessions to the scene,
`src/score.js` turns a score into effect cues (no three.js; tested in `test/tower-score.test.js`), `music/` writes and
renders the BGM and records videos.

CC BY-NC-SA 4.0 (no commercial use). See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-ASSETS.md](https://github.com/realRoc/dsh-screensaver/blob/main/LICENSE-ASSETS.md).
