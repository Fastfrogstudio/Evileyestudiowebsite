/* =================================================================
   EVIL EYE STUDIO — main.js
   Shared interactions: nav, reveal, counters, ticker, games filter
   ================================================================= */
(function () {
  'use strict';

  /* ---------- Game catalog: render both grids from one list ---------- */
  const GAMES = window.EVIL_EYE_GAMES || [];
  // fallbacks used until a game specifies its own stakeCom / stakeUs link
  const STAKE_COM_DEFAULT = (window.EVIL_EYE_STAKE && window.EVIL_EYE_STAKE.com) || 'https://stake.com/casino/group/evil-eye-studio';
  const STAKE_US_DEFAULT = (window.EVIL_EYE_STAKE && window.EVIL_EYE_STAKE.us) || 'https://stake.us/casino/group/evil-eye-studio';
  if (GAMES.length) {
    const cardHTML = (g, i) => {
      const tagKey = (g.tag || '').toLowerCase();
      const soon = tagKey === 'coming soon' || g.comingSoon === true;
      const tagClass = tagKey === 'hot' ? 'tag gold' : soon ? 'tag soon' : 'tag';
      const tagText = g.tag || (soon ? 'Coming Soon' : '');
      const tag = tagText ? `<span class="${tagClass}">${tagText}</span>` : '';
      const delay = i % 4 ? ` data-reveal-delay="${i % 4}"` : '';
      const com = g.stakeCom || STAKE_COM_DEFAULT;
      const us = g.stakeUs || STAKE_US_DEFAULT;
      const actions = soon
        ? `<span class="btn btn-soon" aria-disabled="true">Coming Soon</span>`
        : `<a class="btn btn-primary" href="${com}" target="_blank" rel="noopener">Stake.com</a>
          <a class="btn btn-stake-us" href="${us}" target="_blank" rel="noopener">Stake.us</a>`;
      return `<div class="game-card has-cover${soon ? ' is-soon' : ''}" data-reveal${delay}>
        <div class="game-cover"><span class="cover-fallback">${g.title}</span><img src="${g.cover}" alt="${g.title}" loading="lazy" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'"></div>
        ${tag}
        <div class="game-overlay"><div class="game-play">${actions}</div></div>
      </div>`;
    };
    const html = GAMES.map(cardHTML).join('');
    document.querySelectorAll('.latest-grid, #games .game-grid').forEach((grid) => {
      grid.innerHTML = html;
    });
    // featured banner spotlights the newest game (first in the list)
    const feat = GAMES[0];
    const fb = document.querySelector('.feature-banner');
    if (fb && feat) {
      const h = fb.querySelector('.fb-copy h3');
      const name = fb.querySelector('.fb-name');
      const img = fb.querySelector('.fb-art img');
      const ph = fb.querySelector('.fb-art .ph');
      const bg = fb.querySelector('.fb-bg');
      const comBtn = fb.querySelector('.fb-try');
      const usBtn = fb.querySelector('.fb-us');
      const featSoon = (feat.tag || '').toLowerCase() === 'coming soon' || feat.comingSoon === true;
      if (h) h.textContent = feat.title;
      if (name) name.textContent = feat.maxWin ? `${feat.title} | ${feat.maxWin} max win` : feat.title;
      if (img) { img.src = feat.cover; img.alt = feat.title; if (ph) ph.style.display = 'none'; }
      if (bg) bg.style.backgroundImage = `url('${feat.bg || feat.cover}')`;
      const setLink = (btn, url) => { if (!btn) return; btn.href = url; btn.target = '_blank'; btn.rel = 'noopener'; };
      if (featSoon) {
        // unreleased featured game — no Stake pages yet
        if (comBtn) { comBtn.textContent = 'Coming Soon'; comBtn.removeAttribute('href'); comBtn.classList.add('btn-soon'); comBtn.classList.remove('btn-primary'); }
        if (usBtn) usBtn.style.display = 'none';
      } else {
        setLink(comBtn, feat.stakeCom || STAKE_COM_DEFAULT);
        setLink(usBtn, feat.stakeUs || STAKE_US_DEFAULT);
      }
    }
  }

  /* ---------- Studio hero reel wall (auto-scrolling columns) ---------- */
  const reelWall = document.querySelector('.hero-reels');
  if (reelWall && Array.isArray(window.EVIL_EYE_HERO_REEL) && window.EVIL_EYE_HERO_REEL.length) {
    const imgs = window.EVIL_EYE_HERO_REEL;
    const cols = reelWall.querySelectorAll('.reel-col');
    const tile = (src) => `<div class="reel-tile"><img src="${src}" alt="" loading="lazy"></div>`;
    cols.forEach((col, ci) => {
      const colItems = imgs.filter((_, i) => i % cols.length === ci);
      const html = colItems.map(tile).join('');
      col.innerHTML = html + html; // duplicate for a seamless loop
    });
  }

  /* ---------- Studio showcase sliders (one large image, auto-advancing) ---------- */
  const ASSETS = window.EVIL_EYE_ASSETS || {};
  document.querySelectorAll('.asset-slider').forEach((slider) => {
    const items = ASSETS[slider.dataset.assets] || [];
    if (!items.length) { slider.style.display = 'none'; return; }
    slider.innerHTML = `
      <div class="slides">${items.map((a, i) =>
        `<figure class="slide${i === 0 ? ' active' : ''}"><img src="${a.src}" alt="${a.caption || ''}" loading="lazy"><figcaption>${a.caption || ''}</figcaption></figure>`
      ).join('')}</div>
      ${items.length > 1 ? `<div class="slider-dots">${items.map((_, i) =>
        `<button class="dot${i === 0 ? ' active' : ''}" data-slide="${i}" aria-label="Slide ${i + 1}"></button>`
      ).join('')}</div>` : ''}`;
    if (items.length < 2) return;

    const slides = slider.querySelectorAll('.slide');
    const dots = slider.querySelectorAll('.dot');
    let current = 0;
    let timer;
    const show = (i) => {
      slides[current].classList.remove('active');
      dots[current].classList.remove('active');
      current = (i + slides.length) % slides.length;
      slides[current].classList.add('active');
      dots[current].classList.add('active');
    };
    const play = () => { timer = setInterval(() => show(current + 1), 4500); };
    dots.forEach((d) => d.addEventListener('click', () => { clearInterval(timer); show(+d.dataset.slide); play(); }));
    slider.addEventListener('mouseenter', () => clearInterval(timer));
    slider.addEventListener('mouseleave', play);
    play();
  });

  /* ---------- Sticky header ---------- */
  const header = document.querySelector('.site-header');
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    });
    links.querySelectorAll('a').forEach((a) =>
      a.addEventListener('click', () => {
        links.classList.remove('open');
        toggle.classList.remove('open');
        document.body.style.overflow = '';
      })
    );
  }

  /* ---------- Scroll reveal ---------- */
  const revealEls = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('in'));
  }

  /* ---------- Animated counters ---------- */
  const counters = document.querySelectorAll('[data-count]');
  const animateCount = (el) => {
    const target = parseFloat(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const decimals = (el.dataset.count.split('.')[1] || '').length;
    const dur = 1600;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = target * eased;
      el.textContent = val.toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target.toFixed(decimals) + suffix;
    };
    requestAnimationFrame(tick);
  };
  if (counters.length && 'IntersectionObserver' in window) {
    const cio = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            animateCount(e.target);
            cio.unobserve(e.target);
          }
        });
      },
      { threshold: 0.6 }
    );
    counters.forEach((el) => cio.observe(el));
  } else {
    counters.forEach((el) => (el.textContent = el.dataset.count + (el.dataset.suffix || '')));
  }

  /* ---------- Parallax on floating card scenes ---------- */
  if (window.matchMedia('(pointer:fine)').matches) {
    document.querySelectorAll('.hero-visual, .float-scene').forEach((scene) => {
      const reels = scene.querySelectorAll('.reel');
      if (!reels.length) return;
      scene.addEventListener('mousemove', (e) => {
        const r = scene.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        reels.forEach((reel, i) => {
          const depth = (i + 1) * 6;
          reel.style.translate = `${x * depth}px ${y * depth}px`;
        });
      });
      scene.addEventListener('mouseleave', () => {
        reels.forEach((reel) => (reel.style.translate = '0 0'));
      });
    });
  }

  /* ---------- Smooth anchor scroll (account for fixed header) ---------- */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id === '#' || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const subnav = document.querySelector('.subnav');
      const offset = (header ? header.offsetHeight : 0) + (subnav ? subnav.offsetHeight : 0) + 12;
      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });

  /* ---------- Package "Get a Quote" → scroll to form + prefill ---------- */
  const quoteBtns = document.querySelectorAll('.pkg-quote');
  if (quoteBtns.length) {
    quoteBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const pkg = btn.dataset.package || '';
        const msg = document.getElementById('cmsg');
        if (msg) {
          const line = `Package of interest: ${pkg}\n\n`;
          msg.value = /^Package of interest:.*\n\n/.test(msg.value)
            ? msg.value.replace(/^Package of interest:.*\n\n/, line)
            : line + msg.value;
        }
        const scope = document.getElementById('cscope');
        if (scope && pkg) {
          const opt = Array.from(scope.options).find((o) => o.text === pkg);
          if (opt) scope.value = opt.value;
        }
        const form = document.getElementById('hire');
        if (form) {
          const subnav = document.querySelector('.subnav');
          const offset = (header ? header.offsetHeight : 0) + (subnav ? subnav.offsetHeight : 0) + 12;
          const top = form.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({ top, behavior: 'smooth' });
          setTimeout(() => msg && msg.focus({ preventScroll: true }), 550);
        }
      });
    });
  }

  /* ---------- Contact form (mock) ---------- */
  document.querySelectorAll('form.contact-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const note = form.querySelector('.form-note');
      if (note) note.textContent = 'Thanks — your message is in. Our team will be in touch within 1–2 business days.';
      form.reset();
    });
  });

  /* =============================================================
     GAMES PAGE — filtering, search, sort
     ============================================================= */
  const grid = document.getElementById('gameGrid');
  if (grid) {
    const cards = Array.from(grid.querySelectorAll('.game-card'));
    const search = document.getElementById('searchInput');
    const themeF = document.getElementById('themeFilter');
    const featF = document.getElementById('featureFilter');
    const volF = document.getElementById('volatilityFilter');
    const sortF = document.getElementById('sortFilter');
    const reset = document.getElementById('resetFilters');
    const count = document.getElementById('resultsCount');
    const empty = document.getElementById('noResults');

    const apply = () => {
      const q = (search?.value || '').trim().toLowerCase();
      const theme = themeF?.value || '';
      const feat = featF?.value || '';
      const vol = volF?.value || '';
      let visible = 0;

      cards.forEach((card) => {
        const name = (card.dataset.name || '').toLowerCase();
        const okQ = !q || name.includes(q);
        const okT = !theme || card.dataset.theme === theme;
        const okF = !feat || (card.dataset.features || '').split(',').includes(feat);
        const okV = !vol || card.dataset.volatility === vol;
        const show = okQ && okT && okF && okV;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      if (count) count.textContent = `${visible} game${visible === 1 ? '' : 's'}`;
      if (empty) empty.style.display = visible ? 'none' : 'block';
    };

    const sort = () => {
      const v = sortF?.value || 'newest';
      const sorted = [...cards].sort((a, b) => {
        switch (v) {
          case 'az': return a.dataset.name.localeCompare(b.dataset.name);
          case 'za': return b.dataset.name.localeCompare(a.dataset.name);
          case 'rtp': return parseFloat(b.dataset.rtp) - parseFloat(a.dataset.rtp);
          case 'popular': return parseInt(b.dataset.popularity) - parseInt(a.dataset.popularity);
          default: return parseInt(b.dataset.released) - parseInt(a.dataset.released);
        }
      });
      sorted.forEach((c) => grid.appendChild(c));
    };

    [search, themeF, featF, volF].forEach((el) => el && el.addEventListener('input', apply));
    [themeF, featF, volF].forEach((el) => el && el.addEventListener('change', apply));
    sortF && sortF.addEventListener('change', () => { sort(); apply(); });
    reset && reset.addEventListener('click', () => {
      if (search) search.value = '';
      [themeF, featF, volF].forEach((el) => el && (el.value = ''));
      if (sortF) sortF.value = 'newest';
      sort();
      apply();
    });

    apply();
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
})();
