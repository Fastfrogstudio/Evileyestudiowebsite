/* =================================================================
   EVIL EYE STUDIO — main.js
   Shared interactions: nav, reveal, counters, ticker, games filter
   ================================================================= */
(function () {
  'use strict';

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

  /* ---------- Contact form (mock) ---------- */
  document.querySelectorAll('form.contact-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const note = form.querySelector('.form-note');
      if (note) note.textContent = 'Thanks — your message is in. Our team will be in touch within 1–2 business days.';
      form.reset();
    });
  });

  /* ---------- Showreel play (mock) ---------- */
  document.querySelectorAll('.showreel .play-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.closest('.showreel').querySelector('.reel-label');
      if (label) label.textContent = '▶ Reel coming soon';
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
