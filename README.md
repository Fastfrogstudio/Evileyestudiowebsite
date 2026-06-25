# EvilEyeStudio Website

A bold, dynamic slot provider website inspired by Hacksaw Gaming's design approach. Features aggressive typography, strong visual hierarchy, and creative use of space.

## Design Philosophy

This website embodies the following design principles:

- **Bold Typography**: Using Bebas Neue for display text and Inter for body content
- **Dynamic Layouts**: Grid-based responsive design with creative spacing
- **Strong Visual Hierarchy**: Clear distinction between primary and secondary content
- **Dark Color Scheme**: Deep blacks with vibrant accent colors (pink, cyan, gold)
- **Creative Animations**: Floating symbols, parallax effects, and smooth transitions

## Features

### Homepage (`index.html`)

Structured to closely mirror Hacksaw Gaming's homepage layout:

- **Hero**: Full-bleed featured-game banner (Shadow Realm) with an animated slot-reel machine and a max-win multiplier badge
- **Disruptive Gaming**: Tagline + three headline stats (+50 Games, +150 Operator Brands, +30 Regulated Markets)
- **Latest Games**: One large featured game (Neon Rush) plus a four-tile game grid and a "View All Games" CTA
- **What We Do**: Three product cards — Slots, Scratchcards, Instant Win — on a themed band
- **OpenEye Partnership Program**: Partnership/distribution program section with CTA
- **Latest Articles**: Dated list of partnership and release announcements
- **Contact Section**: Contact form and company contact information
- **Partner Strip**: Row of operator/partner logos
- **Footer**: Comprehensive navigation and legal information

### Games Portfolio (`games.html`)

- **Advanced Filtering System**:
  - Search by game name
  - Filter by theme (Fantasy, Egyptian, Asian, etc.)
  - Filter by features (Free Spins, Multipliers, etc.)
  - Filter by volatility (Low, Medium, High)
  - Filter by RTP range
  - Sort by newest, popular, A-Z, or RTP
  - Reset filters functionality

- **Game Grid**: Responsive grid layout with hover effects
- **Game Cards**: Display RTP, volatility, max win, and features
- **Play Demo/Real Buttons**: Interactive CTAs on hover
- **Pagination**: Navigate through large game portfolio
- **Results Counter**: Shows number of games matching filters

## Technical Stack

- **HTML5**: Semantic markup
- **CSS3**: Custom properties, Grid, Flexbox, animations
- **Vanilla JavaScript**: No dependencies, pure JS for all interactions
- **Google Fonts**: Bebas Neue and Inter

## File Structure

```
Evileyestudiowebsite/
├── index.html              # Homepage
├── games.html              # Games portfolio page
├── css/
│   └── styles.css          # Complete styling
├── js/
│   └── main.js            # All JavaScript functionality
├── images/
│   ├── games/             # Game thumbnails (placeholders)
│   └── symbols/           # Animated symbols (placeholders)
└── README.md              # This file
```

## Key Design Elements

### Color Palette

- **Primary**: #FF0066 (Hot Pink)
- **Secondary**: #00FFFF (Cyan)
- **Accent**: #FFD700 (Gold)
- **Background Dark**: #0A0A0F
- **Background Secondary**: #151520
- **Background Tertiary**: #1F1F2E

### Typography Scale

- **Display (Bebas Neue)**: Used for headlines, titles, and CTAs
- **Body (Inter)**: Used for paragraphs and UI text

### Animations

1. **Floating Symbols**: Gentle float animation on hero section
2. **Scroll Animations**: Fade-in and slide-up on scroll
3. **Hover Effects**: Scale, glow, and transform on interactive elements
4. **Carousel**: Smooth horizontal scrolling
5. **Parallax**: Subtle parallax effect on hero symbols

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Responsive Breakpoints

- **Desktop**: 1200px and above
- **Tablet**: 768px - 1199px
- **Mobile**: Below 768px

## Features Checklist

### Homepage Elements
- [x] Hero section with striking visuals
- [x] New game release promo with animated symbols
- [x] Featured games carousel (3-5 games)
- [x] Company intro (2-3 sentences)
- [x] Key statistics (games, markets, partners)
- [x] Call-to-action buttons
- [x] Latest news/updates section
- [x] Partner logos
- [x] Footer with navigation and social links

### Navigation & Structure
- [x] Clear main menu
- [x] Sticky header
- [x] Mobile hamburger menu
- [x] Smooth scroll navigation

### Games Portfolio Page
- [x] Grid/card layout
- [x] Filter by theme
- [x] Filter by features
- [x] Filter by volatility
- [x] Filter by RTP range
- [x] Sort functionality
- [x] Search functionality
- [x] Game cards with RTP, volatility, max win
- [x] Hover effects
- [x] "Play Demo" buttons
- [x] Pagination

## Performance Optimizations

- CSS custom properties for consistent theming
- Efficient CSS Grid and Flexbox layouts
- Minimal JavaScript dependencies
- Smooth scroll behavior
- Optimized animations using transforms
- Lazy loading ready for images

## Future Enhancements

- Add actual game images
- Implement backend API for dynamic game data
- Add multi-language support
- Integrate with casino platforms
- Add game preview videos
- Implement user reviews and ratings
- Add live game statistics integration
- Create admin panel for content management

## Customization

To customize colors, update the CSS variables in `css/styles.css`:

```css
:root {
    --color-primary: #FF0066;
    --color-secondary: #00FFFF;
    --color-accent: #FFD700;
    /* ... */
}
```

## Credits

Design inspired by Hacksaw Gaming's bold and dynamic approach to slot provider websites.

## License

© 2026 EvilEyeStudio. All rights reserved.

---

**Built with 👁️ by EvilEyeStudio**
