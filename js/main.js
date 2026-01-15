// ================================
// NAVIGATION
// ================================

// Sticky navigation on scroll
const navbar = document.getElementById('navbar');
let lastScroll = 0;

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    if (currentScroll > 100) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }

    lastScroll = currentScroll;
});

// Mobile hamburger menu
const hamburger = document.getElementById('hamburger');
const navMenu = document.getElementById('navMenu');

if (hamburger && navMenu) {
    hamburger.addEventListener('click', () => {
        navMenu.classList.toggle('active');
        hamburger.classList.toggle('active');
    });

    // Close menu when clicking on a link
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navMenu.classList.remove('active');
            hamburger.classList.remove('active');
        });
    });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');

        // Skip if it's just "#" or empty
        if (href === '#' || href === '') {
            e.preventDefault();
            return;
        }

        const target = document.querySelector(href);
        if (target) {
            e.preventDefault();
            const offsetTop = target.offsetTop - 80; // Account for fixed nav

            window.scrollTo({
                top: offsetTop,
                behavior: 'smooth'
            });
        }
    });
});

// ================================
// GAMES CAROUSEL
// ================================

const gamesTrack = document.getElementById('gamesTrack');
const carouselPrev = document.getElementById('carouselPrev');
const carouselNext = document.getElementById('carouselNext');

if (gamesTrack && carouselPrev && carouselNext) {
    const scrollAmount = 370; // Card width + gap

    carouselNext.addEventListener('click', () => {
        gamesTrack.scrollBy({
            left: scrollAmount,
            behavior: 'smooth'
        });
    });

    carouselPrev.addEventListener('click', () => {
        gamesTrack.scrollBy({
            left: -scrollAmount,
            behavior: 'smooth'
        });
    });

    // Update button states based on scroll position
    const updateCarouselButtons = () => {
        const maxScroll = gamesTrack.scrollWidth - gamesTrack.clientWidth;

        if (gamesTrack.scrollLeft <= 0) {
            carouselPrev.style.opacity = '0.5';
            carouselPrev.style.cursor = 'not-allowed';
        } else {
            carouselPrev.style.opacity = '1';
            carouselPrev.style.cursor = 'pointer';
        }

        if (gamesTrack.scrollLeft >= maxScroll - 10) {
            carouselNext.style.opacity = '0.5';
            carouselNext.style.cursor = 'not-allowed';
        } else {
            carouselNext.style.opacity = '1';
            carouselNext.style.cursor = 'pointer';
        }
    };

    gamesTrack.addEventListener('scroll', updateCarouselButtons);
    updateCarouselButtons(); // Initial state
}

// ================================
// GAMES FILTERING & SEARCH
// ================================

const gameSearch = document.getElementById('gameSearch');
const themeFilter = document.getElementById('themeFilter');
const featuresFilter = document.getElementById('featuresFilter');
const volatilityFilter = document.getElementById('volatilityFilter');
const rtpFilter = document.getElementById('rtpFilter');
const sortFilter = document.getElementById('sortFilter');
const resetFilters = document.getElementById('resetFilters');
const gamesGrid = document.getElementById('gamesGrid');
const resultsCount = document.getElementById('resultsCount');

if (gamesGrid) {
    const gameCards = Array.from(gamesGrid.querySelectorAll('.portfolio-game-card'));

    const filterGames = () => {
        const searchTerm = gameSearch ? gameSearch.value.toLowerCase() : '';
        const themeValue = themeFilter ? themeFilter.value : '';
        const featuresValue = featuresFilter ? featuresFilter.value : '';
        const volatilityValue = volatilityFilter ? volatilityFilter.value : '';
        const rtpValue = rtpFilter ? rtpFilter.value : '';
        const sortValue = sortFilter ? sortFilter.value : 'newest';

        let visibleCards = gameCards.filter(card => {
            const gameName = card.getAttribute('data-name').toLowerCase();
            const gameTheme = card.getAttribute('data-theme');
            const gameFeatures = card.getAttribute('data-features');
            const gameVolatility = card.getAttribute('data-volatility');
            const gameRTP = parseFloat(card.getAttribute('data-rtp'));

            // Search filter
            if (searchTerm && !gameName.includes(searchTerm)) {
                return false;
            }

            // Theme filter
            if (themeValue && gameTheme !== themeValue) {
                return false;
            }

            // Features filter
            if (featuresValue && !gameFeatures.includes(featuresValue)) {
                return false;
            }

            // Volatility filter
            if (volatilityValue && gameVolatility !== volatilityValue) {
                return false;
            }

            // RTP filter
            if (rtpValue) {
                if (rtpValue === '97+' && gameRTP < 97) {
                    return false;
                }
                if (rtpValue === '96-97' && (gameRTP < 96 || gameRTP >= 97)) {
                    return false;
                }
                if (rtpValue === '95-96' && (gameRTP < 95 || gameRTP >= 96)) {
                    return false;
                }
            }

            return true;
        });

        // Sort games
        visibleCards.sort((a, b) => {
            const nameA = a.getAttribute('data-name');
            const nameB = b.getAttribute('data-name');
            const rtpA = parseFloat(a.getAttribute('data-rtp'));
            const rtpB = parseFloat(b.getAttribute('data-rtp'));

            switch(sortValue) {
                case 'az':
                    return nameA.localeCompare(nameB);
                case 'za':
                    return nameB.localeCompare(nameA);
                case 'rtp-high':
                    return rtpB - rtpA;
                case 'rtp-low':
                    return rtpA - rtpB;
                case 'popular':
                    // For demo purposes, use a random sort
                    return Math.random() - 0.5;
                case 'newest':
                default:
                    // Keep original order
                    return 0;
            }
        });

        // Hide all cards first
        gameCards.forEach(card => {
            card.style.display = 'none';
        });

        // Show visible cards in sorted order
        visibleCards.forEach((card, index) => {
            card.style.display = 'block';
            card.style.order = index;
        });

        // Update results count
        if (resultsCount) {
            resultsCount.textContent = visibleCards.length;
        }

        // Show "no results" message if needed
        let noResultsMsg = gamesGrid.querySelector('.no-results');
        if (visibleCards.length === 0) {
            if (!noResultsMsg) {
                noResultsMsg = document.createElement('div');
                noResultsMsg.className = 'no-results';
                noResultsMsg.style.gridColumn = '1 / -1';
                noResultsMsg.style.textAlign = 'center';
                noResultsMsg.style.padding = '4rem';
                noResultsMsg.style.fontSize = '1.5rem';
                noResultsMsg.style.color = 'var(--color-text-secondary)';
                noResultsMsg.innerHTML = '<p>No games found matching your criteria.</p><p style="font-size: 1rem; margin-top: 1rem;">Try adjusting your filters or search term.</p>';
                gamesGrid.appendChild(noResultsMsg);
            }
            noResultsMsg.style.display = 'block';
        } else if (noResultsMsg) {
            noResultsMsg.style.display = 'none';
        }
    };

    // Add event listeners
    if (gameSearch) gameSearch.addEventListener('input', filterGames);
    if (themeFilter) themeFilter.addEventListener('change', filterGames);
    if (featuresFilter) featuresFilter.addEventListener('change', filterGames);
    if (volatilityFilter) volatilityFilter.addEventListener('change', filterGames);
    if (rtpFilter) rtpFilter.addEventListener('change', filterGames);
    if (sortFilter) sortFilter.addEventListener('change', filterGames);

    // Reset filters
    if (resetFilters) {
        resetFilters.addEventListener('click', () => {
            if (gameSearch) gameSearch.value = '';
            if (themeFilter) themeFilter.value = '';
            if (featuresFilter) featuresFilter.value = '';
            if (volatilityFilter) volatilityFilter.value = '';
            if (rtpFilter) rtpFilter.value = '';
            if (sortFilter) sortFilter.value = 'newest';
            filterGames();
        });
    }

    // Initial filter
    filterGames();
}

// ================================
// PAGINATION
// ================================

const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const paginationNumbers = document.querySelectorAll('.pagination-number');

if (prevPageBtn && nextPageBtn) {
    paginationNumbers.forEach((btn, index) => {
        btn.addEventListener('click', () => {
            paginationNumbers.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Enable/disable prev/next buttons
            prevPageBtn.disabled = index === 0;
            nextPageBtn.disabled = index === paginationNumbers.length - 1;

            // Scroll to top of games grid
            if (gamesGrid) {
                window.scrollTo({
                    top: gamesGrid.offsetTop - 100,
                    behavior: 'smooth'
                });
            }
        });
    });

    prevPageBtn.addEventListener('click', () => {
        const activePage = document.querySelector('.pagination-number.active');
        const prevPage = activePage.previousElementSibling;
        if (prevPage && prevPage.classList.contains('pagination-number')) {
            prevPage.click();
        }
    });

    nextPageBtn.addEventListener('click', () => {
        const activePage = document.querySelector('.pagination-number.active');
        const nextPage = activePage.nextElementSibling;
        if (nextPage && nextPage.classList.contains('pagination-number')) {
            nextPage.click();
        }
    });
}

// ================================
// CONTACT FORM
// ================================

const contactForm = document.getElementById('contactForm');

if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
        e.preventDefault();

        // Get form data
        const formData = {
            name: document.getElementById('name').value,
            email: document.getElementById('email').value,
            company: document.getElementById('company').value,
            subject: document.getElementById('subject').value,
            message: document.getElementById('message').value
        };

        // For demo purposes, just show an alert
        // In production, this would send data to a server
        console.log('Form submitted:', formData);

        // Show success message
        alert('Thank you for your message! We\'ll get back to you soon.');

        // Reset form
        contactForm.reset();
    });
}

// ================================
// SCROLL ANIMATIONS
// ================================

// Intersection Observer for fade-in animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Apply to various sections (not on initial hero)
const animatedElements = document.querySelectorAll('.service-card, .game-card, .news-card, .portfolio-game-card');
animatedElements.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
});

// ================================
// LANGUAGE SELECTOR
// ================================

const languageSelector = document.getElementById('language');

if (languageSelector) {
    languageSelector.addEventListener('change', (e) => {
        const selectedLanguage = e.target.value;
        console.log('Language changed to:', selectedLanguage);

        // In production, this would trigger language change logic
        // For now, just log it
        alert(`Language changed to: ${selectedLanguage}\n(This is a demo - language switching would be implemented in production)`);

        // Reset to English for demo
        e.target.value = 'en';
    });
}

// ================================
// PLAY DEMO BUTTONS
// ================================

const playDemoBtns = document.querySelectorAll('.btn-play, .btn-play-demo');

playDemoBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();

        // Get game name from parent card
        const gameCard = btn.closest('.game-card, .portfolio-game-card');
        const gameName = gameCard ?
            (gameCard.querySelector('.game-title, .portfolio-game-title')?.textContent || 'this game') :
            'this game';

        alert(`Demo mode for "${gameName}" would launch here.\n\nIn production, this would open the game in demo mode.`);
    });
});

const playRealBtns = document.querySelectorAll('.btn-play-real');

playRealBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();

        // Get game name from parent card
        const gameCard = btn.closest('.portfolio-game-card');
        const gameName = gameCard ?
            (gameCard.querySelector('.portfolio-game-title')?.textContent || 'this game') :
            'this game';

        alert(`Real money mode for "${gameName}" would launch here.\n\nIn production, this would redirect to a casino partner or require login.`);
    });
});

// ================================
// PARTNER CTA BUTTONS
// ================================

const partnerCTAs = document.querySelectorAll('.nav-cta');

partnerCTAs.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();

        // Scroll to contact section
        const contactSection = document.getElementById('contact');
        if (contactSection) {
            window.scrollTo({
                top: contactSection.offsetTop - 80,
                behavior: 'smooth'
            });
        } else {
            // If on games page, redirect to home page contact section
            window.location.href = 'index.html#contact';
        }
    });
});

// ================================
// ENHANCED ANIMATIONS
// ================================

// Add parallax effect to hero symbols
if (window.innerWidth > 768) {
    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const symbols = document.querySelectorAll('.symbol');

        symbols.forEach((symbol, index) => {
            const speed = 0.1 + (index * 0.05);
            const yPos = -(scrolled * speed);
            symbol.style.transform = `translateY(${yPos}px)`;
        });
    });
}

// Add dynamic gradient animation to hero
const heroBackground = document.querySelector('.hero-background');
if (heroBackground) {
    let hue = 0;
    setInterval(() => {
        hue = (hue + 1) % 360;
        // This creates a subtle shifting effect
    }, 50);
}

// Console greeting
console.log('%c👁️ EvilEyeStudio', 'font-size: 24px; font-weight: bold; color: #FF0066;');
console.log('%cWelcome to EvilEyeStudio - Where Creativity Meets Fortune', 'font-size: 14px; color: #00FFFF;');
console.log('%cInterested in working with us? Contact us at hello@evileyestudio.com', 'font-size: 12px; color: #B8B8C8;');
