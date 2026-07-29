/* =========================================================
   EVIL EYE STUDIO — GAME CATALOG (single source of truth)

   To add a game: paste a new block at the TOP of the list (new
   games lead the row, front-left) with tag: 'New'. Set the title
   + cover, and paste the game's Stake.com and Stake.us links, then
   upload the cover image to images/games/. Both the "Latest Games"
   row and "The Portfolio" grid rebuild from this list, and the
   featured banner spotlights whatever is first here.

   Fields:
     title    — game name (shown as the fallback if the cover fails)
     cover    — path to the cover image in images/games/
     tag      — 'New' (purple) or 'Hot' (red); omit for none
     bg       — optional in-game scene image for the featured banner's
                blurred backdrop; falls back to the cover if omitted
     maxWin   — optional; when featured, shows "TITLE | {maxWin} MAX WIN"
                in the banner's bottom caption
     stakeCom — this game's page on Stake.com  (hover "Stake.com" button)
     stakeUs  — this game's page on Stake.us   (hover "Stake.us" button)

   If a game has no stakeCom/stakeUs yet, it falls back to the
   studio pages set in EVIL_EYE_STAKE below.

   Newest first.
   ========================================================= */

// Fallback studio links (used for any game missing its own stakeCom/stakeUs)
window.EVIL_EYE_STAKE = {
  com: 'https://stake.com/casino/group/evil-eye-studio',
  us:  'https://stake.us/casino/group/evil-eye-studio',
};

window.EVIL_EYE_GAMES = [
  {
    title: 'Dog Father',
    cover: 'images/games/evil-eye-studio_dogfather_tile.png',
    tag: 'New',
    stakeCom: 'https://stake.com/casino/games/evileyestudio-dogfather',
    stakeUs:  'https://stake.us/casino/games/evileyestudio-dogfather',
  },
  {
    title: 'Rat Attack',
    cover: 'images/games/ratattack.webp',
    bg: 'images/games/ratattackgame.png',
    maxWin: '50,000x',
    tag: 'New',
    stakeCom: 'https://stake.com/casino/games/evileyestudio-rat-attack',
    stakeUs:  'https://stake.us/casino/games/evileyestudio-rat-attack',
  },
  {
    title: 'Trash Bandits 1000',
    cover: 'images/games/trashbandits1000.webp',
    stakeCom: 'https://stake.com/casino/games/evileyestudio-trash-bandits-1000',
    stakeUs:  'https://stake.us/casino/games/evileyestudio-trash-bandits-1000',
  },
  {
    title: 'Trash Bandits',
    cover: 'images/games/trashbandits.webp',
    stakeCom: 'https://stake.com/casino/games/evileyestudio-trash-bandits',
    stakeUs:  'https://stake.us/casino/games/evileyestudio-trash-bandits',
  },
];
