# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About the Project

NutriTrack is an Italian food diary web application for tracking nutrition and meals. It's a Progressive Web App (PWA) built with vanilla JavaScript and Firebase, featuring barcode scanning, custom meals, recipes, and nutritional goal tracking.

## Key Commands

### Build and Development
- `npm run build:css` - Build and watch Tailwind CSS (compiles input.css to style.css)
- `npm run init:css` - Initialize Tailwind CSS configuration
- `npm run build` - Build Tailwind CSS once
- `npm test` - Run the test suite (`node --test tests/*.test.mjs`)
- `npm run test:rules` - Test `firestore.rules` against the Firestore emulator (needs Java; Homebrew's openjdk is keg-only, so prefix `PATH="/opt/homebrew/opt/openjdk/bin:$PATH"` if `java` is not on PATH)
- `python3 tests/ui-preview.py --serve` - Local UI preview with the real `script.js`, mocked Firebase and sample data (localhost:8765)

### Firebase Deployment
- Use Firebase CLI: `firebase deploy` to deploy hosting and Firestore rules
- `firebase deploy --only firestore:rules` - Deploy only the security rules (`firestore.rules`)
- Configuration is in `firebase.json` with public folder as hosting root

## Architecture Overview

### Frontend Structure
- **`public/index.html`** - Main HTML file with complete UI structure
- **`public/script.js`** - Main application JavaScript (entry point, ~3000+ lines)
- **`public/modules/`** - Modular JavaScript components:
  - `utils.js` - Date utilities, formatting, debouncing
  - `uiHelpers.js` - Toast notifications, UI animations
  - `charts.js` - Chart.js integration for nutrition charts
  - `nutrition.js` - Pure nutrition math: meal totals (with CREA field fallbacks), recipe totals, nutrient detail grouping
  - `foodSearch.js` - Pure search helpers: search tokens, relevance score, sorting, client-side matching
  - `portions.js` / `portionPicker.js` / `mealEntry.js` - Portion units, saved quantities, guided meal entry
  - `scanner.js` - Barcode scanner (html5-qrcode), owns its own state
  - `aiPhotoAnalysis.js` - Gemini photo analysis (API key kept in the user's localStorage)
- **`public/sw.js`** - Service worker: network-first for app files, cache-first for pinned CDN libraries
- **`firestore.rules`** - Security rules: `users/{uid}/**` private to the owner; shared `foods` readable/addable by signed-in users with field validation, no client deletes
- **`public/style.css`** - Generated Tailwind CSS output
- **`public/input.css`** - Tailwind CSS source file
- **`public/firebase-config.js`** - Firebase configuration

### Backend & Data
- **Firebase Firestore** - NoSQL database for storing:
  - User meals and nutrition data
  - Custom foods and recipes
  - Water intake tracking
  - User goals and preferences
- **Firebase Authentication** - Google OAuth integration
- **Firebase Hosting** - Static site hosting

### Key Features
- **Food Database Integration** - Uses CREA (Italian nutrition database) and Open Food Facts API
- **Barcode Scanning** - html5-qrcode library for product scanning
- **Custom Meals & Recipes** - User-created food entries with nutritional calculations
- **Offline Support** - PWA capabilities with offline indicators
- **Responsive Design** - Mobile-first design with Tailwind CSS

### Code Architecture Patterns
- **Modular ES6 Imports** - Clear separation of concerns across modules
- **Event-Driven UI** - Extensive use of event listeners and DOM manipulation
- **State Management** - Global state variables with caching for performance
- **Real-time Updates** - Firebase onSnapshot for live data synchronization

### Data Flow
1. User authentication via Firebase Auth
2. Real-time meal/nutrition data sync with Firestore
3. Local caching for performance (dailyMealsCache, dailyTotalsCache)
4. Chart updates triggered by data changes
5. Progressive enhancement with offline support

## Development Notes

- The app is entirely client-side with no build process except CSS compilation
- Security is enforced by `firestore.rules` (versioned in the repo, deployed with the Firebase CLI)
- All strings and UI are in Italian
- Uses modern JavaScript features (ES6 modules, async/await)
- Chart.js for data visualizations
- Tests use the built-in `node:test` runner; `tests/app-portions.test.mjs` evaluates `script.js` in a `vm` context with imports stripped, so functions from new modules used by `script.js` must be added to that harness context
- Pure logic goes in `public/modules/` (testable); DOM and Firestore code stays in `script.js`
- Escape any user or shared-database string inserted via `innerHTML` with `escapeText()`
- CDN script URLs in `index.html` are pinned to exact versions
