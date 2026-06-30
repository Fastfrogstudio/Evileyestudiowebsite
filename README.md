# Evil Eye Studio — Website

A bold, dark, Hacksaw-inspired website for **Evil Eye Studio** — an iGaming slot
provider **and** an art & animation studio for hire. Two divisions, one eye.

## Concept

Evil Eye runs two divisions, and the site is built around that split:

- **Slots** — a B2B slot provider showcasing original, certified games.
- **Art & Animation** — a creative studio for hire (concept art, characters,
  symbols, 2D/3D animation, UI, sound) that builds slot games for operators and
  other providers.

A **division switcher** in the header (Slots ⇄ Art & Animation) re-themes the
accent palette and routes between the two sides. The studio page has its **own
sub-navigation bar** dedicated to creative services.

## Pages

| File          | Purpose                                                            |
|---------------|-------------------------------------------------------------------|
| `index.html`  | Slots home — hero, ticker, new release, portfolio, divisions, stats, about, news, partners, contact |
| `studio.html` | Art & Animation studio — own sub-nav, showreel, services, gallery, process, hire form |
| `games.html`  | Full games portfolio with live search / filter / sort            |

## Stack

- **HTML5 + CSS3 + vanilla JS** — no build step, no dependencies. Open any
  `.html` file in a browser (or serve the folder) and it just works.
- **Fonts:** Anton (display) + Space Grotesk (body) via Google Fonts, with
  system fallbacks.
- **JS** (`js/main.js`): sticky header, mobile menu, scroll-reveal, animated
  counters, hero parallax, games filtering, mock forms. Progressive enhancement —
  content stays visible if JS doesn't run.

## Design tokens

Edit the CSS custom properties at the top of `css/styles.css`:

```css
:root {
  --accent:   #ff0a6c;  /* slots: electric magenta */
  --accent-2: #19e3ff;  /* cyan */
  --accent-3: #ffc24b;  /* gold */
}
body[data-division='studio'] {
  --accent:   #8a5bff;  /* studio: violet */
  --accent-2: #2bf0c8;  /* mint */
}
```

## Placeholders to swap as we iterate

- Game/symbol **emoji** stand in for real key art and thumbnails.
- The **showreel** and **gallery** are placeholders for real video/frames.
- Game stats, news, partners, and contact details are sample copy.

## Local preview

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

---

© Evil Eye Studio. Built with 👁️ — bold slots, made by artists.
