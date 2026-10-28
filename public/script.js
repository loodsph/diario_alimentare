// Importa le funzioni necessarie da Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, onSnapshot, query, where, Timestamp, doc, deleteDoc, orderBy, getDocs, setDoc, getDoc, limit, runTransaction, documentId, writeBatch, updateDoc, waitForPendingWrites } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { dayKey, weekDates, editPortion, mealTemplate } from './modules/diary.js?v=20261028';
import { createWriteTracker } from './modules/sync.js';
import { loadScript } from './modules/lazy.js';
import { preparePhoto } from './modules/photo.js';
import { debounce, getDayBounds, formatDate, getMealTimestamp, getTodayUTC } from './modules/utils.js';
import { showToast, triggerFlashAnimation } from './modules/uiHelpers.js';
import { initCharts, updateCharts, destroyCharts } from './modules/charts.js';
import { firebaseConfig } from './firebase-config.js';
import { startScanner, stopScanner, handleCameraChange, toggleFlash, handleFileSelect } from './modules/scanner.js';
import { getGeminiApiKey, saveGeminiApiKey, analyzePhoto, refineWithAnswer, parseResponse } from './modules/aiPhotoAnalysis.js';
import { estimateLabel, estimateRange, estimateBreakdown } from './modules/mealEstimate.js?v=20261028';
import { createEstimateEditor } from './modules/estimateEditor.js';
import { createDishEstimateEditor } from './modules/dishEstimateEditor.js';
import { createMealEntry } from './modules/mealEntry.js';
import { createPortionPicker } from './modules/portionPicker.js?v=20261028';
import { positive, formatAmount, nutritionPer100g, foodKey, productPortions, portionDescription, readPortionHistory, rememberPortion } from './modules/portions.js?v=20261025';
import { emptyTotals, addTotals, mealNutrition, computeRecipeNutrition, findMissingIngredients, groupNutrientDetails, MAX_RECIPE_INGREDIENTS } from './modules/nutrition.js';
import { searchTokens, normalizeQuery, queryToken, sortResults, matchesSearch, buildUsageStats } from './modules/foodSearch.js';

// --- STATO GLOBALE DELL'APPLICAZIONE ---
// Le variabili sono raggruppate per responsabilità per facilitare la navigazione.

// Firebase
let app, auth, db;

// Auth & ciclo di vita
let userId = null;
let isAppInitialized = false;
let isOnline = navigator.onLine;

// Navigazione temporale
let selectedDate = getTodayUTC();

// Dati applicazione
let allMeals = [];
let dailyMealsCache = {};       // Pasti raggruppati per categoria (per rendering)
let dailyTotalsCache = {};      // Totali nutrizionali per data
let foods = [];                  // Cache on-demand degli alimenti (popolata dalle ricerche)
let recipes = [];
let favoriteMeals = [];
let habitualMeals = [];
let habitualUnsubscribe = null;
let dayLoadStates = {};
let snapshotPending = false;
let waterPending = false;
let habitsPending = false;
let restoredWritesPending = false;
let syncCounts = { pending: 0, failed: 0 };
let chartsReady = false;
let chartsLoading = null;
let mealListenerGeneration = 0;
let groupDraft = null;
let photoGeneration = 0;
const writeTracker = createWriteTracker(counts => { syncCounts = counts; renderSyncStatus(); }, message => showToast(message, true));

function renderSyncStatus() {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.textContent = syncCounts.failed ? `${syncCounts.failed} salvataggi non riusciti`
        : syncCounts.pending || snapshotPending || waterPending || habitsPending || restoredWritesPending ? (isOnline ? 'Sincronizzazione in corso…' : 'Salvato sul dispositivo · da sincronizzare')
        : isOnline ? 'Sincronizzato' : 'Offline · dati sul dispositivo';
    document.getElementById('retry-sync')?.classList.toggle('hidden', !syncCounts.failed);
}
function queueWrite(operation, label, onSynced, key) {
    return writeTracker.submit(operation, { label, onSynced, key });
}
async function showInsights() {
    if (mealEntry?.currentView() !== 'insights') return;
    const session = userId;
    if (!chartsReady) {
        document.getElementById('chart-status').textContent = 'Caricamento grafici…';
        try {
            chartsLoading ||= loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js');
            await chartsLoading;
            if (userId !== session || mealEntry?.currentView() !== 'insights') return;
            if (!chartsReady) initCharts(document.getElementById('calorie-chart').getContext('2d'), document.getElementById('macro-chart').getContext('2d'));
            chartsReady = true;
            document.getElementById('chart-status').textContent = 'Le interruzioni indicano giorni senza registrazioni.';
            document.getElementById('retry-charts').classList.add('hidden');
        } catch (error) {
            chartsLoading = null;
            document.getElementById('chart-status').textContent = error.message;
            document.getElementById('retry-charts').classList.remove('hidden');
            return;
        }
    }
    const days = weekDates(selectedDate);
    document.getElementById('chart-period').textContent = `${formatDate(days[0])} – ${formatDate(selectedDate)}`;
    updateCharts(dailyTotalsCache, selectedDate);
}


// Obiettivi nutrizionali
let nutritionGoals = {
    calories: 2000,
    proteins: 150,
    carbs: 250,
    fats: 70,
    fibers: 30,
    water: 8
};

// Tracciamento acqua
let waterCount = 0;
let waterHistory = {};

// Stato UI e form
let selectedFood = null;
let portionPicker = null;
let isCustomMealMode = false;
let mealToEditId = null;
let editedMealEstimate = null;
let estimateEditor = null;
let dishEstimateEditor = null;
let foodToEditId = null;
let recipeToEditId = null;
let onConfirmAction = null;
let ingredientCounter = 0;
let currentRecipeIngredientResults = [];

// Listener Firestore (unsubscribe functions)
let mealsUnsubscribe = null;
let recipesUnsubscribe = null;
let waterUnsubscribe = null;
let waterHistoryUnsubscribe = null;
let favoriteMealsUnsubscribe = null;

// Vista ispezionabile dello stato per il debug (es. console.log(appState))
const appState = {
    get auth() { return { userId, isAppInitialized, isOnline }; },
    get navigation() { return { selectedDate: selectedDate.toISOString() }; },
    get data() {
        return {
            meals: allMeals.length,
            foodsCache: foods.length,
            recipes: recipes.length,
            favoriteMeals: favoriteMeals.length,
        };
    },
    get water() { return { waterCount, historyDays: Object.keys(waterHistory).length }; },
    get ui() {
        return {
            selectedFood: selectedFood?.name ?? null,
            isCustomMealMode,
            mealToEditId,
            foodToEditId,
            recipeToEditId,
        };
    },
    get goals() { return { ...nutritionGoals }; },
};

// --- FUNZIONI UTILITY ORARI ---

function getDefaultMealTypeByTime() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTime = hours * 60 + minutes; // Converti in minuti totali

    // Definisci i range orari in minuti (partendo da mezzanotte = 0)
    const breakfast = { start: 6 * 60, end: 10 * 60 + 30 }; // 06:00 - 10:30
    const lunch = { start: 13 * 60, end: 16 * 60 + 30 }; // 13:00 - 16:30
    const dinner = { start: 20 * 60, end: 24 * 60 }; // 20:00 - 23:59

    // Cena può andare anche oltre mezzanotte (00:00 - 05:59)
    const dinnerEarly = { start: 0, end: 5 * 60 + 59 }; // 00:00 - 05:59

    if ((currentTime >= breakfast.start && currentTime <= breakfast.end)) {
        return '🌅 Colazione';
    } else if (currentTime >= lunch.start && currentTime <= lunch.end) {
        return '🍽️ Pranzo';
    } else if (currentTime >= dinner.start || currentTime <= dinnerEarly.end) {
        return '🌙 Cena';
    } else {
        return '🍪 Spuntino';
    }
}

// --- INIZIALIZZAZIONE ---

// Usiamo DOMContentLoaded per garantire che tutti gli script (inclusi quelli con 'defer')
// siano stati caricati ed eseguiti prima di avviare l'app.
// Questo risolve la "race condition" con la libreria ZXing.
window.addEventListener('DOMContentLoaded', () => {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Cache locale persistente: i dati già visti restano disponibili anche offline.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    setupListeners();

    onAuthStateChanged(auth, async (user) => {
        const loadingOverlay = document.getElementById('loading-overlay');
        const loginScreen = document.getElementById('login-screen');
        const appContainer = document.getElementById('app');
        if (user) {
            isAppInitialized = false; // Resetta il flag ad ogni login
            try {
                loginScreen.classList.add('hidden');
                // Resetta la data a oggi (UTC) ad ogni login/refresh per coerenza.
                selectedDate = getTodayUTC();

                userId = user.uid;
                loginScreen.classList.add('hidden');
                loadingOverlay.classList.remove('hidden');
                
                updateUserUI(user);

                // Carica tutti i dati iniziali in parallelo e attendi il completamento
                // per evitare race conditions e rendering con dati parziali.
                await loadInitialData();
                if (userId !== user.uid) return;
                restoredWritesPending = true;
                waitForPendingWrites(db).then(() => {
                    if (userId === user.uid) { restoredWritesPending = false; renderSyncStatus(); }
                }).catch(() => {});

                // Ora che tutti i dati sono caricati e processati, aggiorna l'intera UI.
                updateAllUI();

                // Imposta il tipo di pasto di default basato sull'orario
                initializeMealTypeByTime();
                
                // Avvia il listener per i dati dell'acqua del giorno corrente.
                listenToWaterData();

                // L'inizializzazione è completata con successo.
                isAppInitialized = true;

                // Avvia i listener in tempo reale SOLO ORA che l'app è pronta.
                // Questo previene il doppio caricamento e le race condition.
                listenToMeals();
                listenToRecipes();
                listenToFavoriteMeals();
                listenToWaterHistory();
                listenToHabitualMeals();
                updateOnlineStatus(navigator.onLine);

                appContainer.classList.remove('hidden');
            } catch (error) {
                console.error("Errore critico durante l'inizializzazione:", error);
                showToast("Errore durante il caricamento dell'app.", true);
            } finally {
                loadingOverlay.classList.add('hidden');
            }
        } else {
            isAppInitialized = false;
            userId = null;
            loginScreen.classList.remove('hidden');
            loginScreen.classList.add('flex'); // Aggiungi 'flex' per renderlo visibile correttamente
            updateUserUI(null);
            appContainer.classList.add('hidden');
            loadingOverlay.classList.add('hidden');
            if (waterUnsubscribe) waterUnsubscribe();
            if (waterHistoryUnsubscribe) waterHistoryUnsubscribe();
            waterCount = 0;
            waterHistory = {};
            renderWaterTracker();
            resetAppData();
        }
    });
});

// --- GESTIONE EVENTI ---

let mealEntry = null;
function setupListeners() {
    window.addEventListener('online', () => updateOnlineStatus(true));
    window.addEventListener('offline', () => updateOnlineStatus(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && groupDraft) closeMealGroup();
        if (event.key !== 'Tab' || !groupDraft) return;
        const controls = [...document.getElementById('meal-group-modal').querySelectorAll('button, input, select')].filter(el => el.getClientRects().length && !el.disabled);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    mealEntry = createMealEntry(document, { onViewChange: view => { if (view === 'insights') showInsights(); if (view === 'library') renderWeeklyHistory(); }, onCustomContinue: () => {
        const name = document.getElementById('custom-meal-name').value.trim();
        const valid = ['calories', 'proteins', 'carbs', 'fats'].every(key => {
            const value = document.getElementById(`custom-meal-${key}`).value;
            return value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
        });
        document.getElementById('custom-meal-error').textContent = name && valid ? '' : 'Inserisci il nome e valori nutrizionali validi per 100 g (anche zero).';
        if (!name || !valid) return false;
        updateMealPreview();
        return { name };
    } });
    portionPicker = createPortionPicker(document, updateMealPreview);
    estimateEditor = createEstimateEditor(document, food => selectMealFood(food, food));
    dishEstimateEditor = createDishEstimateEditor(document, food => selectMealFood(food));
    document.getElementById('describe-dish-btn').addEventListener('click', () => dishEstimateEditor.open());
    document.getElementById('estimate-meal-btn').addEventListener('click', () => estimateEditor.open());
    document.getElementById('edit-estimate-btn').addEventListener('click', () => estimateEditor.open(selectedFood, portionPicker.quantity()));
    document.getElementById('edit-saved-estimate-btn').addEventListener('click', editSavedEstimate);
    // Dichiaro le variabili per gli input qui per evitare errori di riferimento
    const foodSearchInput = document.getElementById('food-search');

    // Navigazione date
    document.getElementById('prev-day').addEventListener('click', () => changeDay(-1));
    document.getElementById('next-day').addEventListener('click', () => changeDay(1));
    document.getElementById('today-btn').addEventListener('click', () => changeDay(0));
    document.getElementById('date-picker').addEventListener('change', handleDateChange);

    // Modali e Form
    document.getElementById('edit-goals-btn').addEventListener('click', openGoalsModal);
    document.getElementById('cancel-goals-btn').addEventListener('click', closeGoalsModal);
    document.getElementById('save-goals-btn').addEventListener('click', saveAndCloseGoalsModal);

    // Calcolo automatico calorie negli obiettivi
    document.getElementById('toggle-custom-meal-btn').addEventListener('click', toggleCustomMealForm);
    document.getElementById('goal-proteins').addEventListener('input', updateCalculatedCalories);
    document.getElementById('goal-carbs').addEventListener('input', updateCalculatedCalories);
    document.getElementById('goal-fats').addEventListener('input', updateCalculatedCalories);

    document.getElementById('add-ingredient-btn').addEventListener('click', addIngredientRow);
    document.getElementById('save-recipe-btn').addEventListener('click', saveRecipe);
    document.getElementById('add-food-btn').addEventListener('click', addNewFood);
    document.getElementById('add-meal-btn').addEventListener('click', () => addMeal(false));
    document.getElementById('add-another-meal-btn').addEventListener('click', () => addMeal(true));
    document.getElementById('retry-sync').addEventListener('click', () => writeTracker.retry());
    document.getElementById('retry-history').addEventListener('click', listenToMeals);
    document.getElementById('retry-charts').addEventListener('click', showInsights);
    document.getElementById('cancel-meal-group').addEventListener('click', closeMealGroup);
    document.getElementById('save-meal-group').addEventListener('click', saveMealGroup);
    document.getElementById('edit-meal-unit').addEventListener('change', changeEditUnit);
    document.getElementById('edit-meal-quantity').addEventListener('input', updateEditPortionHint);
    document.getElementById('selected-day-meals').addEventListener('click', handleGroupAction);
    document.getElementById('habitual-meals').addEventListener('click', handleHabitualAction);

    // Pasti preferiti toggle e azioni
    document.getElementById('favorite-meals-toggle').addEventListener('click', toggleFavoriteMeals);
    document.getElementById('add-to-favorites-btn').addEventListener('click', addToFavorites);

    // Modale di conferma generico
    document.getElementById('save-edit-meal-btn').addEventListener('click', saveMealChanges);
    document.getElementById('cancel-edit-meal-btn').addEventListener('click', () => {
        document.getElementById('edit-meal-modal').classList.add('hidden');
    });

    // Modale modifica alimento
    document.getElementById('edit-lookup-food-btn').addEventListener('click', openEditFoodModal);
    document.getElementById('save-edit-food-btn').addEventListener('click', saveFoodChanges);
    document.getElementById('cancel-edit-food-btn').addEventListener('click', () => {
        document.getElementById('edit-food-modal').classList.add('hidden');
    });
    document.getElementById('confirm-action-btn').addEventListener('click', executeConfirmAction);
    document.getElementById('cancel-confirmation-btn').addEventListener('click', hideConfirmationModal);

    // Water Tracker
    document.getElementById('add-water-btn').addEventListener('click', () => incrementWaterCount(1));
    document.getElementById('remove-water-btn').addEventListener('click', () => incrementWaterCount(-1));
    document.getElementById('reset-water-btn').addEventListener('click', () => setWaterCount(0));

    // Auth
    document.getElementById('login-btn').addEventListener('click', signInWithGoogle);
    document.getElementById('logout-btn').addEventListener('click', logout);

    // Scanner
    document.getElementById('scan-barcode-btn').addEventListener('click', () => {
        startScanner(barcode => fetchFoodFromBarcode(barcode, populateMealForm));
    });
    document.getElementById('scan-barcode-for-new-food-btn').addEventListener('click', () => {
        startScanner(barcode => fetchFoodFromBarcode(barcode, populateNewFoodForm));
    });
    document.getElementById('close-scanner-btn').addEventListener('click', stopScanner);
    document.getElementById('camera-select').addEventListener('change', handleCameraChange);
    document.getElementById('toggle-flash-btn').addEventListener('click', toggleFlash);
    document.getElementById('scan-from-file-btn').addEventListener('click', () => document.getElementById('barcode-file-input').click());
    document.getElementById('barcode-file-input').addEventListener('change', handleFileSelect);

    // AI Photo Analysis
    document.getElementById('ai-photo-btn').addEventListener('click', openAiPhotoModal);
    document.getElementById('close-ai-photo-btn').addEventListener('click', closeAiPhotoModal);
    document.getElementById('save-api-key-btn').addEventListener('click', handleSaveApiKey);
    document.getElementById('ai-photo-input').addEventListener('change', handleAiPhotoSelect);
    document.getElementById('ai-analyze-btn').addEventListener('click', handleAiAnalyze);
    document.getElementById('ai-refine-btn').addEventListener('click', handleAiRefine);
    document.getElementById('ai-use-data-btn').addEventListener('click', handleAiUseData);
    document.getElementById('ai-reset-key-btn').addEventListener('click', handleAiResetKey);
    document.getElementById('ai-quantity-correction').addEventListener('change', event => {
        if (!aiCurrentParsed) return;
        aiCurrentParsed.quantita_stimata_g = Number(event.target.value);
        renderAiResults(aiCurrentParsed);
    });

    // Search functionality setup
    const searchResultsContainer = document.getElementById('search-results');
    setupSearchHandler({
        inputElement: foodSearchInput,
        resultsContainer: searchResultsContainer,
        searchFunction: searchFoodsAndRecipes,
        onResultClick: (item) => {
            selectMealFood(item);
        },
        itemRenderer: (item) => {
            if (item.isRecipe) {
                return `
                <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" role="button" tabindex="0" data-item-id="${escapeText(item.id)}">
                    <i class="fas fa-book text-orange-400 mr-3"></i>
                    <div>
                        <div class="font-medium text-slate-200">${escapeText(item.name)}</div>
                        <div class="text-sm text-slate-400">Ricetta · ${item.servings} porzioni${positive(item.finalWeight) ? ` · ${formatAmount(item.finalWeight / item.servings)} g ciascuna` : ' · scegli la tua frazione'}</div>
                    </div>
                </div>`;
            }
            return `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" role="button" tabindex="0" data-item-id="${escapeText(item.id)}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${escapeText(item.name)}</div>
                    <div class="text-sm text-slate-400">${item.calories} cal/100g</div>
                </div>
            </div>`;
        }
    });

    foodSearchInput.addEventListener('input', () => {
        // A newly typed name must never reuse the previously selected food.
        selectedFood = null;
        portionPicker.select();
        updateMealPreview();
    });

    // Food search input focus/blur effects
    foodSearchInput.addEventListener('focus', () => {
        document.getElementById('food-search-icon').classList.add('opacity-0');

        // Add body class to handle viewport adjustments on mobile
        document.body.classList.add('search-input-active');
    });
    foodSearchInput.addEventListener('blur', () => {
        if (foodSearchInput.value === '') document.getElementById('food-search-icon').classList.remove('opacity-0');

        // Remove body class when search input loses focus
        document.body.classList.remove('search-input-active');
    });

    // Food lookup search setup
    const foodLookupInput = document.getElementById('food-lookup-search');
    setupSearchHandler({
        inputElement: foodLookupInput,
        resultsContainer: document.getElementById('food-lookup-results-list'),
        searchFunction: searchFoodsOnly,
        onResultClick: (item) => {
            foodLookupInput.value = item.name;
            showFoodLookupDetails(item);
        },
        itemRenderer: (item) => `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" role="button" tabindex="0" data-item-id="${escapeText(item.id)}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${escapeText(item.name)}</div>
                    <div class="text-sm text-slate-400">${item.calories} cal/100g</div>
                </div>
            </div>
        `
    });

    // Set up search for initial recipe ingredient input (if it exists)
    const initialIngredientInput = document.querySelector('.recipe-ingredient-name');
    if (initialIngredientInput) {
        setupIngredientSearch(initialIngredientInput);
    }

    foodLookupInput.addEventListener('focus', () => {
        document.getElementById('food-lookup-search-icon').classList.add('opacity-0');
    });
    foodLookupInput.addEventListener('blur', () => {
        if (foodLookupInput.value === '') document.getElementById('food-lookup-search-icon').classList.remove('opacity-0');
    });
    // Nasconde il pulsante "Modifica" e i dettagli quando l'utente inizia a digitare una nuova ricerca
    foodLookupInput.addEventListener('input', () => {
        document.getElementById('edit-lookup-food-btn').classList.add('hidden');
        document.getElementById('food-lookup-details').classList.add('hidden');
    });

    // Document-level event delegation for UI interactions
    document.addEventListener('click', function(e) {
        const target = e.target;

        // Hide search results when clicking outside
        if (!target.closest('#food-search-wrapper')) {
            const searchResults = document.getElementById('search-results');
            searchResults.className = 'search-results mt-2 max-h-60 overflow-y-auto absolute w-full hidden';
            searchResults.style.display = 'none';
        }

        // Hide food lookup results when clicking outside
        if (!target.closest('#food-lookup-wrapper')) {
            const lookupResults = document.getElementById('food-lookup-results-list');
            lookupResults.classList.add('hidden');
            lookupResults.style.display = 'none';
        }

        // Hide recipe ingredient results when clicking outside
        document.querySelectorAll('.recipe-ingredient-results').forEach(results => {
            if (!target.closest('.ingredient-row')) {
                results.classList.add('hidden');
                results.style.display = 'none';
            }
        });

        // Handle collapsible sections
        const sectionHeader = target.closest('.section-header');
        if (sectionHeader) {
            const section = sectionHeader.parentElement;
            const content = section.querySelector('.section-content');
            const toggleIcon = sectionHeader.querySelector('.toggle-icon');
            const isCollapsed = section.classList.contains('collapsed');

            if (isCollapsed) {
                // Expand section
                section.classList.remove('collapsed');
                content.style.display = 'block';
                sectionHeader.setAttribute('aria-expanded', 'true');
                toggleIcon.style.transform = 'rotate(180deg)';

                setTimeout(() => {
                    content.style.height = content.scrollHeight + 'px';
                }, 10);

                setTimeout(() => {
                    content.style.height = 'auto';
                }, 310);
            } else {
                // Collapse section
                content.style.height = content.scrollHeight + 'px';

                setTimeout(() => {
                    content.style.height = '0';
                    sectionHeader.setAttribute('aria-expanded', 'false');
                    toggleIcon.style.transform = 'rotate(0deg)';
                }, 10);

                setTimeout(() => {
                    content.style.display = 'none';
                    section.classList.add('collapsed');
                }, 310);
            }
        }

        // Handle meal item clicks for mobile
        const mealItem = target.closest('.meal-item');
        if (mealItem && !target.closest('.meal-actions')) {
            if (mealItem.classList.contains('is-active')) {
                mealItem.classList.remove('is-active');
            } else {
                document.querySelectorAll('.meal-item.is-active').forEach(item => item.classList.remove('is-active'));
                mealItem.classList.add('is-active');
            }
        }

        // Handle recipe card clicks for mobile
        const recipeCard = target.closest('.recipe-card');
        if (recipeCard && !target.closest('.recipe-actions')) {
            if (recipeCard.classList.contains('is-active')) {
                recipeCard.classList.remove('is-active');
            } else {
                document.querySelectorAll('.recipe-card.is-active').forEach(item => item.classList.remove('is-active'));
                recipeCard.classList.add('is-active');
            }
        }

        // Handle action buttons
        const deleteMealBtn = target.closest('.delete-meal-btn');
        if (deleteMealBtn) {
            const mealId = deleteMealBtn.dataset.mealId;
            if (mealId) deleteMeal(mealId);
        }

        const editMealBtn = target.closest('.edit-meal-btn');
        if (editMealBtn) {
            const mealId = editMealBtn.dataset.mealId;
            if (mealId) openEditMealModal(mealId);
        }

        const deleteRecipeBtn = target.closest('.delete-recipe-btn');
        if (deleteRecipeBtn) {
            const recipeId = deleteRecipeBtn.dataset.recipeId;
            if (recipeId) deleteRecipe(recipeId);
        }

        const useRecipeBtn = target.closest('.use-recipe-btn');
        if (useRecipeBtn) {
            const recipeId = useRecipeBtn.dataset.recipeId;
            if (recipeId) useRecipe(recipeId);
        }

        const editRecipeBtn = target.closest('.edit-recipe-btn');
        if (editRecipeBtn) {
            const recipeId = editRecipeBtn.dataset.recipeId;
            if (recipeId) openRecipeEditor(recipeId);
        }

        const removeIngredientBtn = target.closest('.remove-ingredient-btn');
        if (removeIngredientBtn) {
            removeIngredientBtn.closest('.ingredient-row').remove();
            updateRecipeBuilderMacroBar();
        }
    });
}



// --- FUNZIONI DI AUTH E STATO CONNESSIONE ---

function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider)
        .then(result => showToast(`Benvenuto, ${result.user.displayName}!`))
        .catch(error => {
            console.error("Errore di autenticazione:", error);
            showToast(`Errore di autenticazione: ${error.message}`, true);
        });
}

function logout() {
    signOut(auth)
        .then(() => showToast('Sei stato disconnesso.'))
        .catch(error => {
            console.error("Errore logout:", error);
            showToast('Errore durante il logout.', true);
        });
}

function updateOnlineStatus(online) {
    isOnline = online;
    document.getElementById('offline-indicator').classList.toggle('show', !online);
    renderSyncStatus();
    if (online) {
        showToast('Sei di nuovo online!', false);
        // Quando torno online, nascondo i pulsanti dei pasti che potrebbero essere rimasti attivi
        // per evitare stati visivi incoerenti.
        setTimeout(() => {
            document.querySelectorAll('.meal-item.is-active').forEach(item => item.classList.remove('is-active'));
        }, 1000);
    } else {
        showToast('Offline: puoi continuare a registrare pasti e acqua.');
    }
}

function toggleCustomMealForm() {
    isCustomMealMode = !isCustomMealMode;
    const searchContainer = document.getElementById('food-search-container');
    const customContainer = document.getElementById('custom-meal-container');
    const toggleText = document.getElementById('toggle-custom-meal-text');
    const quantityInput = document.getElementById('meal-quantity');

    if (isCustomMealMode) {
        searchContainer.classList.remove('active');
        searchContainer.classList.add('hidden');
        customContainer.classList.add('active');
        customContainer.classList.remove('hidden');
        toggleText.textContent = 'Cerca alimento';
        quantityInput.value = '';
        quantityInput.disabled = false;
        selectedFood = null; // Deseleziona qualsiasi alimento
        document.getElementById('food-search').value = '';
        document.getElementById('search-results').style.display = 'none';
        updateMealPreview(); // Nasconde l'anteprima
    } else {
        searchContainer.classList.add('active');
        searchContainer.classList.remove('hidden');
        customContainer.classList.remove('active');
        customContainer.classList.add('hidden');
        toggleText.textContent = 'Crea pasto personalizzato';
        quantityInput.disabled = false;
        quantityInput.value = '';
    }
    portionPicker.select();
}


// --- FUNZIONI DI MANIPOLAZIONE DATI (Firebase, API) ---

async function loadInitialData() {
    if (!userId) return;
    const owner = userId;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const mealsQuery = query(collection(db, `users/${userId}/meals`), where('date', '>=', Timestamp.fromDate(thirtyDaysAgo)), orderBy('date', 'desc'));
    const recipesQuery = collection(db, `users/${userId}/recipes`);

    // Promise.allSettled garantisce che un errore parziale non blocchi tutto il caricamento.
    const [mealsResult, recipesResult, goalsResult] = await Promise.allSettled([
        getDocs(mealsQuery),
        getDocs(recipesQuery),
        loadNutritionGoals()
    ]);

    if (owner !== userId) return;
    if (mealsResult.status === 'fulfilled') {
        allMeals = mealsResult.value.docs.map(doc => ({ id: doc.id, ...doc.data(), jsDate: doc.data().date.toDate() }));
    } else {
        console.error("Errore caricamento pasti:", mealsResult.reason);
        showToast("Errore nel caricare i pasti.", true);
    }

    if (recipesResult.status === 'fulfilled') {
        recipes = recipesResult.value.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } else {
        console.error("Errore caricamento ricette:", recipesResult.reason);
    }

    if (goalsResult.status === 'rejected') {
        console.error("Errore caricamento obiettivi:", goalsResult.reason);
    }

    // Ordina i pasti e calcola i totali una sola volta dopo il caricamento iniziale.
    processInitialMeals();
}

function mealContent(meal) {
    if (!meal) return '';
    const { pending, ...data } = meal;
    return JSON.stringify(data);
}
function listenToMeals() {
    mealsUnsubscribe?.();
    if (!userId) return;
    const generation = ++mealListenerGeneration;
    const owner = userId;
    const days = weekDates(selectedDate);
    const { start } = getDayBounds(days[0]);
    const { end } = getDayBounds(selectedDate);
    days.forEach(day => dayLoadStates[dayKey(day)] = 'loading');
    renderHistoryStatus();
    renderSelectedDayMeals();
    const request = query(collection(db, `users/${owner}/meals`), where('date', '>=', Timestamp.fromDate(start)), where('date', '<=', Timestamp.fromDate(end)));
    mealsUnsubscribe = onSnapshot(request, { includeMetadataChanges: true }, snapshot => {
        if (owner !== userId || generation !== mealListenerGeneration) return;
        const incoming = snapshot.docs.map(entry => ({ id: entry.id, ...entry.data(), jsDate: entry.data().date.toDate(), pending: entry.metadata.hasPendingWrites }));
        const affected = new Set();
        const incomingById = new Map(incoming.map(meal => [meal.id, meal]));
        allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end).forEach(meal => {
            const next = incomingById.get(meal.id);
            if (!next || mealContent(next) !== mealContent(meal)) affected.add(dayKey(meal.jsDate));
        });
        const previousById = new Map(allMeals.map(meal => [meal.id, meal]));
        incoming.forEach(meal => {
            if (mealContent(previousById.get(meal.id)) !== mealContent(meal)) affected.add(dayKey(meal.jsDate));
        });
        allMeals = [...allMeals.filter(meal => meal.jsDate < start || meal.jsDate > end), ...incoming];
        days.forEach(day => dayLoadStates[dayKey(day)] = snapshot.metadata.fromCache ? 'cached' : 'ready');
        snapshotPending = snapshot.metadata.hasPendingWrites;
        renderSyncStatus(); renderHistoryStatus();
        affected.forEach(recalculateDay);
        // Status transitions must also repaint empty states; unchanged lists are preserved.
        renderSelectedDayMeals();
        if (mealEntry?.currentView() === 'library') renderWeeklyHistory();
        if (affected.size && mealEntry?.currentView() === 'insights') showInsights();
    }, error => {
        if (owner !== userId || generation !== mealListenerGeneration) return;
        days.forEach(day => dayLoadStates[dayKey(day)] = 'error');
        renderHistoryStatus(); renderSelectedDayMeals();
        console.error('Caricamento storico:', error);
    });
}
function recalculateDay(key) {
    delete dailyMealsCache[key];
    const meals = allMeals.filter(meal => dayKey(meal.jsDate) === key);
    if (!meals.length) { delete dailyTotalsCache[key]; return; }
    const totals = emptyTotals();
    meals.forEach(meal => addTotals(totals, mealNutrition(meal)));
    dailyTotalsCache[key] = totals;
}
function renderHistoryStatus() {
    const state = dayLoadStates[dayKey(selectedDate)];
    document.getElementById('history-status').textContent = state === 'loading' ? 'Caricamento della settimana…'
        : state === 'cached' ? 'Dati disponibili sul dispositivo: lo storico potrebbe essere incompleto.'
        : state === 'error' ? 'Impossibile caricare lo storico. I dati già disponibili restano visibili.' : '';
    document.getElementById('retry-history').classList.toggle('hidden', state !== 'error');
}

function listenToRecipes() {
    if (recipesUnsubscribe) recipesUnsubscribe(); // Chiude il listener precedente per evitare memory leak
    try {
        const recipesCollection = collection(db, `users/${userId}/recipes`);
        recipesUnsubscribe = onSnapshot(recipesCollection, (snapshot) => {
            recipes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderRecipes();
        });
    } catch (error) {
        console.error("Errore nell'avvio del listener delle ricette:", error);
    }
}

async function loadNutritionGoals() {
    if (!userId) return;
    const owner = userId;
    try {
        const goalsDoc = doc(db, `users/${userId}/goals/nutrition`);
        const docSnap = await getDoc(goalsDoc);
        if (owner !== userId) return;
        if (docSnap.exists()) {
            const loadedGoals = docSnap.data();
            // Unisce gli obiettivi caricati con quelli di default per garantire che tutti i campi esistano
            nutritionGoals = { ...nutritionGoals, ...loadedGoals };
        } else {
            const defaults = { ...nutritionGoals };
            if (isOnline && !docSnap.metadata.fromCache) queueWrite(() => setDoc(goalsDoc, defaults), 'Salvataggio obiettivi iniziali');
        }
        updateGoalsInputs();
    } catch (error) {
        console.error("Errore caricamento obiettivi:", error);
    }
}

async function saveNutritionGoals() {
    if (!userId || !isOnline) {
        showToast("Impossibile salvare gli obiettivi offline.", true);
        return;
    }
    try {
        const goalsDoc = doc(db, `users/${userId}/goals/nutrition`);
        await setDoc(goalsDoc, nutritionGoals);
    } catch (error) {
        console.error("Errore salvataggio obiettivi:", error);
        showToast("Errore nel salvare gli obiettivi.", true);
    }
}

async function addMeal(keepOpen = false) {
    if (!userId) return;
    
    const quantity = portionPicker.quantity();
    if (!positive(quantity)) return showToast('Inserisci una quantità maggiore di zero.', true);
    const foodSnapshot = selectedFood;
    const portionSnapshot = portionPicker.metadata();
    const customUnitSnapshot = portionPicker.customUnit();
    const userSnapshot = userId;
    const mealType = document.getElementById('meal-type').value;
    let mealData;

    if (isCustomMealMode) {
        const name = document.getElementById('custom-meal-name').value.trim();
        const calories = parseFloat(document.getElementById('custom-meal-calories').value);
        const proteins = parseFloat(document.getElementById('custom-meal-proteins').value);
        const carbs = parseFloat(document.getElementById('custom-meal-carbs').value);
        const fats = parseFloat(document.getElementById('custom-meal-fats').value);
        const saveAsNewFood = document.getElementById('save-custom-meal-as-food').checked;

        if (!name || ![calories, proteins, carbs, fats].every(value => Number.isFinite(value) && value >= 0)) {
            return showToast('Inserisci nome e valori nutrizionali validi, maggiori o uguali a zero.', true);
        }

        // I valori inseriti sono per 100g, la quantità è il moltiplicatore.
        mealData = {
            name,
            calories,
            proteins,
            carbs,
            fats,
            fibers: 0,
            quantity: quantity,
            type: mealType,
            isCustom: true // Aggiungiamo un flag per identificarlo
        };

        // Se l'utente ha scelto di salvare il pasto personalizzato come nuovo alimento
        if (saveAsNewFood) {
            // Riutilizziamo la logica di addNewFood, ma con i dati del form personalizzato
            // Non è necessario attendere (await) il completamento, può essere eseguito in background.
            addNewFoodFromData({
                name, calories, proteins, carbs, fats,
                fibers: 0 // Il form personalizzato non ha le fibre
            }).catch(error => {
                console.error("Errore nel salvataggio in background del nuovo alimento:", error);
            });
        }

    } else {
        if (!selectedFood || !Number.isFinite(quantity) || quantity <= 0) {
            return showToast('Seleziona un alimento e inserisci una quantità valida.', true);
        }

        try {
            mealData = { ...selectedFood, ...nutritionPer100g(selectedFood), quantity, type: mealType, isCustom: false,
                recipeId: selectedFood.isRecipe ? selectedFood.id : selectedFood.recipeId || null };
        } catch (error) {
            return showToast(error.message, true);
        }
    }

    if (!mealData) {
        return showToast("Dati del pasto non validi.", true);
    }

    const addBtn = document.getElementById('add-meal-btn');
    const originalBtnHTML = addBtn.innerHTML;

    try {
        addBtn.disabled = true;
        document.getElementById('add-another-meal-btn').disabled = true;
        addBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Aggiungo...`;

        const mealDate = getMealTimestamp(mealType, selectedDate);

        // Ordering needs no server round trip and works offline.
        const sortIndex = Date.now();
        let docToAdd = {
            name: mealData.name,
            quantity: mealData.quantity,
            type: mealData.type,
            date: Timestamp.fromDate(mealDate),
            sortIndex: sortIndex,
            recipeId: mealData.recipeId || null,
            foodId: foodSnapshot && !foodSnapshot.isRecipe ? foodSnapshot.foodId || foodSnapshot.id || null : null,
            portion: portionSnapshot,
            customUnit: customUnitSnapshot,
            estimated: Boolean(foodSnapshot?.estimated),
            estimate: foodSnapshot?.estimate || null,
            aiEstimate: foodSnapshot?.aiEstimate || null,
            isCustom: mealData.isCustom
        };

        if (mealData.isCustom) {
            // Per i pasti personalizzati, salviamo i valori nutrizionali direttamente nel documento del pasto
            docToAdd.calories = mealData.calories;
            docToAdd.proteins = mealData.proteins;
            docToAdd.carbs = mealData.carbs;
            docToAdd.fats = mealData.fats;
            docToAdd.fibers = mealData.fibers;
        } else {
            // Per i pasti standard, calcoliamo i valori per 100g
            docToAdd.calories = mealData.calories || 0;
            docToAdd.proteins = mealData.proteins || 0;
            docToAdd.carbs = mealData.carbs || 0;
            docToAdd.fats = mealData.fats || 0;
            docToAdd.fibers = mealData.fibers || 0;
        }
        const ref = doc(collection(db, `users/${userSnapshot}/meals`));
        const foodToRemember = foodSnapshot || { name: mealData.name, ...nutritionPer100g(mealData) };
        queueWrite(() => setDoc(ref, docToAdd), 'Aggiunta del pasto', () => {
            rememberPortion(localStorage, userSnapshot, foodToRemember, quantity, docToAdd.portion, docToAdd.customUnit);
            renderRecentPortions();
        });
        showToast(keepOpen ? 'Pasto registrato. Aggiungi il prossimo alimento.' : 'Pasto registrato.');
        if (selectedFood === foodSnapshot && portionPicker.quantity() === quantity) resetAddMealForm(keepOpen, mealType);
    } catch (error) {
        console.error("Errore aggiunta pasto:", error);
        showToast("Si è verificato un errore.", true);
    } finally {
        addBtn.disabled = false;
        document.getElementById('add-another-meal-btn').disabled = false;
        addBtn.innerHTML = originalBtnHTML;
    }
}

// --- FUNZIONI PASTI PREFERITI ---

function escapeText(value) {
    return String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function selectMealFood(food, saved = null) {
    if (isCustomMealMode) toggleCustomMealForm();
    selectedFood = food;
    document.getElementById('food-search').value = food.name;
    document.getElementById('search-results').classList.add('hidden');
    const previous = saved || readPortionHistory(localStorage, userId).find(entry => entry.key === foodKey(food)) || (food.portion && positive(food.quantity) ? food : null);
    portionPicker.select(food, previous);
    updateMealPreview();
    mealEntry?.select(food);
}

function renderRecentPortions() {
    const entries = readPortionHistory(localStorage, userId).slice(0, 6);
    const container = document.getElementById('recent-portions-container');
    const list = document.getElementById('recent-portions');
    list.replaceChildren();
    container.classList.toggle('hidden', entries.length === 0);
    entries.forEach(entry => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'portion-chip';
        const name = document.createElement('span');
        name.className = 'block font-semibold';
        name.textContent = entry.food.name;
        const detail = document.createElement('span');
        detail.className = 'block text-xs text-slate-300 mt-1';
        detail.textContent = portionDescription(entry.portion) || `${formatAmount(entry.quantity)} g`;
        button.append(name, detail);
        button.addEventListener('click', () => {
            const currentRecipe = entry.food.isRecipe && recipes.find(recipe => recipe.id === entry.food.id);
            selectMealFood(currentRecipe ? { ...currentRecipe, isRecipe: true } : entry.food, entry);
        });
        list.appendChild(button);
    });
}

function updateFavoriteMealsUI() {
    const container = document.getElementById('favorite-meals-container');

    if (!container || !favoriteMeals.length) {
        if (container) container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    const buttonsContainer = document.getElementById('favorite-meals-content');
    buttonsContainer.innerHTML = '';

    favoriteMeals.forEach(meal => {
        const button = document.createElement('button');
        button.className = 'favorite-meal-btn btn-modern btn-secondary text-base px-5 py-4 w-full text-left';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-favorite-btn text-red-400 hover:text-red-300 text-sm px-2';
        removeBtn.innerHTML = '<i class="fas fa-times"></i>';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            removeFavoriteMeal(meal.id);
        };

        const label = document.createElement('span');
        label.className = 'block';
        label.textContent = meal.name;
        const detail = document.createElement('span');
        detail.className = 'block text-sm text-slate-300 mt-1';
        detail.textContent = portionDescription(meal.portion) || (positive(meal.quantity) ? `${formatAmount(meal.quantity)} g` : 'Scegli la quantità');
        button.append(label, detail);
        button.onclick = () => selectFavoriteMeal(meal);
        // Keep the removal button outside the selection button for keyboard access.
        removeBtn.setAttribute('aria-label', `Rimuovi ${meal.name} dai preferiti`);
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2';
        row.append(button, removeBtn);
        buttonsContainer.appendChild(row);
    });
}

function selectFavoriteMeal(meal) {
    if (meal.recipeId) {
        const recipe = recipes.find(item => item.id === meal.recipeId);
        if (recipe) return selectMealFood({ ...recipe, isRecipe: true }, meal);
    }
    selectMealFood({ ...meal, id: meal.foodId || undefined, isRecipe: false }, meal);
}

function toggleFavoriteMeals() {
    const content = document.getElementById('favorite-meals-content');
    const chevron = document.getElementById('favorite-meals-chevron');

    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        chevron.classList.add('rotate-180');
    } else {
        content.classList.add('hidden');
        chevron.classList.remove('rotate-180');
    }
}

async function addToFavorites() {
    if (!selectedFood) {
        showToast('Seleziona prima un alimento', true);
        return;
    }
    const quantity = portionPicker.quantity();
    if (!positive(quantity)) return showToast('Scegli una quantità prima di salvare il preferito.', true);

    const existingFavorite = favoriteMeals.find(meal => meal.name === selectedFood.name);

    try {
        const favoriteData = {
            name: selectedFood.name,
            ...nutritionPer100g(selectedFood),
            recipeId: selectedFood.isRecipe ? selectedFood.id : selectedFood.recipeId || null,
            foodId: selectedFood.isRecipe ? null : selectedFood.foodId || selectedFood.id || null,
            quantity,
            portion: portionPicker.metadata(),
            customUnit: portionPicker.customUnit(),
            servingGrams: selectedFood.servingGrams || null,
            servingLabel: selectedFood.servingLabel || null,
            packageGrams: selectedFood.packageGrams || null,
            barcode: selectedFood.barcode || null,
            estimated: Boolean(selectedFood.estimated),
            estimate: selectedFood.estimate || null,
            aiEstimate: selectedFood.aiEstimate || null,
            createdAt: existingFavorite?.createdAt || Timestamp.now()
        };

        if (existingFavorite) {
            await updateDoc(doc(db, `users/${userId}/favoriteMeals`, existingFavorite.id), favoriteData);
        } else {
            await addDoc(collection(db, `users/${userId}/favoriteMeals`), favoriteData);
        }
        showToast(existingFavorite ? 'Porzione preferita aggiornata!' : `${selectedFood.name} aggiunto ai preferiti!`);
    } catch (error) {
        console.error("Errore aggiunta preferito:", error);
        showToast("Errore nell'aggiungere ai preferiti", true);
    }
}

async function removeFavoriteMeal(mealId) {
    try {
        await deleteDoc(doc(db, `users/${userId}/favoriteMeals`, mealId));
        showToast('Rimosso dai preferiti');
    } catch (error) {
        console.error("Errore rimozione preferito:", error);
        showToast("Errore nella rimozione", true);
    }
}

async function deleteMeal(mealId) {
    const meal = allMeals.find(item => item.id === mealId);
    if (!meal || !userId) return;
    const owner = userId;
    const ref = doc(db, `users/${owner}/meals`, mealId);
    const restored = { ...mealTemplate(meal), type: meal.type, date: Timestamp.fromDate(meal.jsDate), sortIndex: meal.sortIndex || 0 };
    queueWrite(() => deleteDoc(ref), 'Eliminazione del pasto', undefined, ref.path);
    const notice = document.createElement('div');
    notice.className = 'undo-notice';
    const label = document.createElement('span'); label.textContent = `${meal.name} eliminato`;
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'Annulla';
    button.addEventListener('click', () => {
        if (userId === owner) queueWrite(() => setDoc(ref, restored), 'Ripristino del pasto', undefined, ref.path);
        notice.remove();
    }, { once: true });
    notice.append(label, button); document.getElementById('undo-notices').append(notice);
    setTimeout(() => notice.remove(), 10000);
}

async function saveMealChanges() {
    if (!mealToEditId) return;

    const amount = Number(document.getElementById('edit-meal-quantity').value);
    const newName = document.getElementById('edit-meal-name-input').value.trim();
    const newType = document.getElementById('edit-meal-type').value;
    const mealRef = doc(db, `users/${userId}/meals`, mealToEditId);
    const mealToEdit = allMeals.find(m => m.id === mealToEditId);
    if (!mealToEdit) return showToast('Pasto non trovato.', true);
    if (!newName || !positive(amount)) return showToast('Inserisci un nome e una quantità maggiore di zero.', true);
    const edited = editPortion(editedMealEstimate || mealToEdit, amount, document.getElementById('edit-meal-unit').value === 'original');
    const newQuantity = edited.quantity;
    
    let dataToUpdate = {
        ...(editedMealEstimate ? mealTemplate(editedMealEstimate) : {}),
        name: newName,
        type: newType,
        date: Timestamp.fromDate(getMealTimestamp(newType, mealToEdit.jsDate || selectedDate)),
        ...edited
    };

    if (mealToEdit.isCustom) {
        const calories = parseFloat(document.getElementById('edit-meal-calories').value);
        const proteins = parseFloat(document.getElementById('edit-meal-proteins').value);
        const carbs = parseFloat(document.getElementById('edit-meal-carbs').value);
        const fats = parseFloat(document.getElementById('edit-meal-fats').value);

        if (![calories, proteins, carbs, fats].every(value => Number.isFinite(value) && value >= 0)) {
            return showToast('Compila tutti i campi del pasto personalizzato.', true);
        }

        dataToUpdate = {
            ...dataToUpdate,
            calories,
            proteins,
            carbs,
            fats
        };
    } else {
        if (isNaN(newQuantity) || newQuantity <= 0) {
            return showToast('Inserisci una quantità valida.', true);
        }
        dataToUpdate.quantity = newQuantity;
    }

    try {
        queueWrite(() => updateDoc(mealRef, dataToUpdate), 'Modifica del pasto', undefined, mealRef.path);
        showToast('Pasto aggiornato con successo!');
        document.getElementById('edit-meal-modal').classList.add('hidden');
        mealToEditId = null;
    } catch (error) {
        console.error("Errore aggiornamento pasto:", error);
        showToast("Errore durante l'aggiornamento del pasto.", true);
    }
}

async function addNewFood() {
    if (!isOnline) return showToast("Sei offline. Impossibile aggiungere.", true);

    const name = document.getElementById('new-food-name').value.trim();
    const calories = parseFloat(document.getElementById('new-food-calories').value);
    const proteins = parseFloat(document.getElementById('new-food-proteins').value);
    const carbs = parseFloat(document.getElementById('new-food-carbs').value);
    const fats = parseFloat(document.getElementById('new-food-fats').value);
    const fibers = parseFloat(document.getElementById('new-food-fibers').value) || 0;

    if (!name || isNaN(calories) || isNaN(proteins) || isNaN(carbs) || isNaN(fats)) {
        return showToast('Compila tutti i campi con valori validi.', true);
    }
    
    const addBtn = document.getElementById('add-food-btn');
    const originalBtnHTML = addBtn.innerHTML;

    try {
        addBtn.disabled = true;
        addBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Aggiungo...`;

        const foodsCollectionRef = collection(db, 'foods');
        const q = query(foodsCollectionRef, where('name_lowercase', '==', name.toLowerCase()), limit(1));
        const querySnapshot = await getDocs(q);

        if (!querySnapshot.empty) {
            const userConfirmed = window.confirm(`⚠️ Attenzione: un alimento chiamato "${name}" esiste già. Vuoi aggiungerlo comunque?`);
            if (!userConfirmed) {
                showToast('Aggiunta annullata.');
                return;
            }
        }

        const search_tokens = searchTokens(name);

        await addDoc(foodsCollectionRef, {
            name, calories, proteins, carbs, fats, fibers,
            name_lowercase: name.toLowerCase(),
            search_tokens // Aggiunge i token al nuovo documento
        });
        showToast(`${name} aggiunto al database!`);
        resetNewFoodForm();
    } catch (error) {
        console.error("Errore aggiunta alimento:", error);
        showToast("Si è verificato un errore.", true);
    } finally {
        addBtn.disabled = false;
        addBtn.innerHTML = originalBtnHTML;
    }
}

async function saveFoodChanges() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);
    if (!foodToEditId) return;

    const name = document.getElementById('edit-food-name').value.trim();
    const calories = parseFloat(document.getElementById('edit-food-calories').value);
    const proteins = parseFloat(document.getElementById('edit-food-proteins').value);
    const carbs = parseFloat(document.getElementById('edit-food-carbs').value);
    const fats = parseFloat(document.getElementById('edit-food-fats').value);
    const fibers = parseFloat(document.getElementById('edit-food-fibers').value) || 0;

    if (!name || isNaN(calories) || isNaN(proteins) || isNaN(carbs) || isNaN(fats)) {
        return showToast('Compila tutti i campi con valori validi.', true);
    }

    const foodRef = doc(db, 'foods', foodToEditId);
    const search_tokens = searchTokens(name);

    const dataToUpdate = {
        name, calories, proteins, carbs, fats, fibers,
        name_lowercase: name.toLowerCase(),
        search_tokens
    };

    try {
        await updateDoc(foodRef, dataToUpdate);
        showToast('Alimento aggiornato con successo!');
        document.getElementById('edit-food-modal').classList.add('hidden');
    } catch (error) {
        console.error("Errore aggiornamento alimento:", error);
        showToast("Errore durante l'aggiornamento dell'alimento.", true);
    }
}

/**
 * Aggiunge un nuovo alimento al database a partire da un oggetto dati.
 * Utile per salvare pasti personalizzati o dati da altre fonti.
 * @param {object} foodData - Oggetto con i dati dell'alimento (name, calories, etc.).
 */
async function addNewFoodFromData(foodData) {
    if (!isOnline) { showToast('Pasto registrabile offline; per aggiungere il nuovo alimento al database riprova con la rete.', true); return; }

    const { name, calories, proteins, carbs, fats, fibers } = foodData;

    if (!name || isNaN(calories) || isNaN(proteins) || isNaN(carbs) || isNaN(fats)) {
        console.error("Dati alimento non validi per il salvataggio:", foodData);
        return;
    }

    try {
        const foodsCollectionRef = collection(db, 'foods');
        const q = query(foodsCollectionRef, where('name_lowercase', '==', name.toLowerCase()), limit(1));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            const search_tokens = searchTokens(name);
            await addDoc(foodsCollectionRef, {
                name, calories, proteins, carbs, fats, fibers: fibers || 0,
                name_lowercase: name.toLowerCase(),
                search_tokens
            });
            showToast(`"${name}" è stato salvato nel tuo database alimenti.`);
        }
    } catch (error) {
        console.error("Errore durante il salvataggio del nuovo alimento da dati:", error);
    }
}

function readRecipeIngredients() {
    return Array.from(document.querySelectorAll('#recipe-ingredients > div'))
        .map(el => {
            const nameInput = el.querySelector('.recipe-ingredient-name');
            return {
                name: nameInput.value.trim(),
                quantity: parseFloat(el.querySelector('.recipe-ingredient-quantity').value),
                foodId: nameInput.dataset.foodId // Recupera l'ID salvato
            };
        })
        .filter(ing => ing.name && ing.quantity > 0);
}

// Crea una nuova ricetta o, se recipeToEditId è impostato, aggiorna quella in modifica.
async function saveRecipe() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);
    const editingId = recipeToEditId;

    const name = document.getElementById('recipe-name').value.trim();
    const servings = Number(document.getElementById('recipe-servings').value);
    const finalWeightInput = document.getElementById('recipe-final-weight').value;
    const finalWeight = finalWeightInput === '' ? null : Number(finalWeightInput);
    if (finalWeightInput !== '' && !positive(finalWeight)) return showToast('Inserisci un peso finale maggiore di zero.', true);
    if (!name) return showToast('Inserisci un nome per la ricetta.', true);
    if (!positive(servings)) return showToast('Il numero di porzioni deve essere maggiore di zero.', true);

    const ingredients = readRecipeIngredients();
    if (ingredients.length === 0) return showToast('Aggiungi almeno un ingrediente valido.', true);
    if (ingredients.length > MAX_RECIPE_INGREDIENTS) {
        return showToast(`Una ricetta non può avere più di ${MAX_RECIPE_INGREDIENTS} ingredienti (limite del database).`, true);
    }

    const saveBtn = document.getElementById('save-recipe-btn');
    if (saveBtn.disabled) return; // Evita salvataggi doppi da click ripetuti
    const originalBtnHTML = saveBtn.innerHTML;

    try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Salvataggio...`;

        // 1. Recupera i dati di tutti gli ingredienti con una sola query
        const ingredientIds = [...new Set(ingredients.map(ing => ing.foodId).filter(id => id))];
        const foodDataMap = new Map();
        if (ingredientIds.length > 0) {
            const q = query(collection(db, 'foods'), where(documentId(), 'in', ingredientIds));
            const snapshot = await getDocs(q);
            snapshot.forEach(doc => foodDataMap.set(doc.id, doc.data()));
        }

        // 2. Verifica che tutti gli ingredienti siano stati trovati nel database
        const missingIngredients = findMissingIngredients(ingredients, foodDataMap);
        if (missingIngredients.length > 0) {
            const missingNames = missingIngredients.map(ing => ing.name).join(', ');
            return showToast(`Ingredienti non validi: ${missingNames}. Selezionali dalla lista per confermarli.`, true);
        }

        // 3. Calcola i totali nutrizionali e il peso totale
        const { totalNutrition, totalWeight } = computeRecipeNutrition(ingredients, foodDataMap);
        const recipeData = {
            name,
            name_lowercase: name.toLowerCase(),
            ingredients: ingredients.map(({ name, quantity, foodId }) => ({ name, quantity, foodId })),
            servings,
            finalWeight,
            totalNutrition,
            totalWeight
        };

        if (editingId) {
            await updateDoc(doc(db, `users/${userId}/recipes`, editingId), recipeData);
            showToast(`Ricetta "${name}" aggiornata!`);
            exitRecipeEditMode();
        } else {
            await addDoc(collection(db, `users/${userId}/recipes`), recipeData);
            showToast(`Ricetta "${name}" salvata!`);
            resetRecipeForm();
        }
    } catch (error) {
        console.error("Errore salvataggio ricetta:", error);
        showToast(editingId ? "Si è verificato un errore durante l'aggiornamento." : "Si è verificato un errore.", true);
    } finally {
        saveBtn.disabled = false;
        // Dopo un aggiornamento riuscito exitRecipeEditMode ha già impostato il testo del pulsante.
        if (recipeToEditId === editingId) saveBtn.innerHTML = originalBtnHTML;
    }
}

async function deleteRecipe(recipeId) {
    if (!isOnline) return showToast("Sei offline. Impossibile eliminare.", true);
    
    showConfirmationModal("Sei sicuro di voler eliminare questa ricetta? L'azione è irreversibile.", async () => {
        try {
            await deleteDoc(doc(db, `users/${userId}/recipes`, recipeId));
            showToast('Ricetta eliminata con successo!');
        } catch (error) {
            console.error("Errore eliminazione ricetta:", error);
            showToast("Errore durante l'eliminazione.", true);
        }
    });
}

function useRecipe(recipeId) {
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) return showToast('Ricetta non trovata.', true);
    selectMealFood({ ...recipe, isRecipe: true });
    document.getElementById('add-meal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Scegli quanto ne hai mangiato e aggiungi al diario.');
}

async function fetchFoodFromBarcode(barcode, callback) {
    showToast('Ricerca prodotto in corso...');
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Prodotto non trovato.');
        
        const data = await response.json();
        if (data.status !== 1 || !data.product) {
            return showToast('Prodotto non trovato o dati incompleti.', true);
        }
        
        const { product_name, nutriments } = data.product;
        // Mappa per tradurre i nomi dei campi di Open Food Facts in quelli usati internamente
        const nutrientMap = {
            'energy-kcal_100g': 'calories',
            'proteins_100g': 'proteins',
            'carbohydrates_100g': 'carbs',
            'fat_100g': 'fats',
            'fiber_100g': 'fibers',
            'sugars_100g': 'zuccheri_solubili_g',
            'saturated-fat_100g': 'acidi_grassi_saturi_g', // Nota: l'unità è g, non % come in alcuni dati CREA
            'salt_100g': 'sale_g',
            'sodium_100g': 'sodio_mg', // Verrà convertito in mg
            'calcium_100g': 'calcio_mg', // Verrà convertito in mg
            'iron_100g': 'ferro_mg', // Verrà convertito in mg
            'potassium_100g': 'potassio_mg', // Verrà convertito in mg
            'vitamin-c_100g': 'vitamina_c_mg', // Verrà convertito in mg
            'vitamin-a_100g': 'vitamina_a_retinolo_equivalente_mcg' // Verrà convertito in µg
        };

        const foodData = { name: product_name || 'Nome non disponibile', barcode, ...productPortions(data.product) };

        for (const [offKey, appKey] of Object.entries(nutrientMap)) {
            let value = nutriments[offKey] || 0;
            // Converte g in mg per sodio, calcio, ferro, potassio, vitamina C
            if (['sodio_mg', 'calcio_mg', 'ferro_mg', 'potassio_mg', 'vitamina_c_mg'].includes(appKey)) value *= 1000;
            // Converte UI in µg per la Vitamina A (approssimazione comune, 1 UI ≈ 0.3 µg)
            if (appKey === 'vitamina_a_retinolo_equivalente_mcg' && offKey.endsWith('_iu')) value *= 0.3;
            foodData[appKey] = value;
        }

        // Gestione speciale per le calorie se non presenti in kcal
        if (!foodData.calories && nutriments.energy_100g) {
            foodData.calories = nutriments.energy_100g / 4.184;
        }

        callback(foodData); // Chiama la funzione di callback con i dati arricchiti
    } catch (error) {
        console.error('Errore API Open Food Facts:', error);
        showToast(error.message, true);
    }
}

function listenToFavoriteMeals() {
    if (favoriteMealsUnsubscribe) favoriteMealsUnsubscribe(); // Chiude il listener precedente
    if (!userId) return;

    const favoriteMealsQuery = query(
        collection(db, `users/${userId}/favoriteMeals`),
        orderBy('createdAt', 'desc')
    );

    favoriteMealsUnsubscribe = onSnapshot(favoriteMealsQuery, (snapshot) => {
        favoriteMeals = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // Aggiorna l'UI solo se l'app è inizializzata
        if (isAppInitialized) {
            updateFavoriteMealsUI();
        }
    });
}

// --- FUNZIONI DI RENDERING E AGGIORNAMENTO UI ---

function updateAllUI() {
    updateDateDisplay();
    renderSelectedDayMeals();
    if (mealEntry?.currentView() === 'library') renderWeeklyHistory();
    if (mealEntry?.currentView() === 'insights') showInsights();
    updateFavoriteMealsUI();
    renderRecentPortions();
}

function updateUserUI(user) {
    const topBar = document.getElementById('top-bar');
    if (user) {
        document.getElementById('user-photo').src = user.photoURL || 'https://via.placeholder.com/150';
        document.getElementById('user-photo').alt = `Foto profilo di ${user.displayName}`;
        document.getElementById('user-name').textContent = user.displayName || 'Utente';
        document.getElementById('user-email').textContent = user.email;
        topBar.classList.remove('hidden');
        topBar.classList.add('flex');
    } else {
        topBar.classList.add('hidden');
        topBar.classList.remove('flex');
    }
}

function updateDateDisplay() {
    const displayElement = document.getElementById('current-date-display');
    const infoElement = document.getElementById('day-info');
    const datePickerElement = document.getElementById('date-picker');
    
    displayElement.textContent = formatDate(selectedDate);
    
    const today = getTodayUTC();
    // Crea nuove date per l'inizio del giorno per evitare di modificare gli oggetti originali
    // e per garantire che vengano confrontate solo le parti della data in UTC.
    const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const startOfSelectedDay = new Date(Date.UTC(selectedDate.getUTCFullYear(), selectedDate.getUTCMonth(), selectedDate.getUTCDate()));

    const diffTime = startOfSelectedDay.getTime() - startOfToday.getTime();
    // Usa Math.round per un calcolo più robusto della differenza di giorni, gestendo piccole differenze di orario e l'ora legale.
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        infoElement.textContent = "📅 Oggi"; // Questo rimane corretto perché il confronto è tra date UTC
    } else if (diffDays === 1) {
        infoElement.textContent = "⏭️ Domani";
    } else if (diffDays === -1) {
        infoElement.textContent = "⏮️ Ieri";
    } else if (diffDays > 0) {
        infoElement.textContent = `📆 Fra ${diffDays} giorni`;
    } else {
        infoElement.textContent = `📆 ${Math.abs(diffDays)} giorni fa`;
    }
    
    // Imposta il valore del date picker usando le componenti UTC della data
    const year = selectedDate.getUTCFullYear();
    const month = (selectedDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = selectedDate.getUTCDate().toString().padStart(2, '0');
    datePickerElement.value = `${year}-${month}-${day}`;
}

function renderSelectedDayMeals() {
    const mainContainer = document.getElementById('selected-day-meals');
    const dateKey = selectedDate.toISOString().split('T')[0];
    let mealsByCategory;
    
    // Controlla se i dati per questo giorno sono già in cache per evitare ricalcoli
    if (dailyMealsCache[dateKey]) {
        mealsByCategory = dailyMealsCache[dateKey];
    } else {
        // Altrimenti, calcola, ordina e metti in cache
        const { start, end } = getDayBounds(selectedDate);
        const dayMeals = allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end);
        
        mealsByCategory = { '🌅 Colazione': [], '🍽️ Pranzo': [], '🌙 Cena': [], '🍪 Spuntino': [] };
        dayMeals.forEach(meal => {
            if (mealsByCategory[meal.type]) {
                mealsByCategory[meal.type].push(meal);
            }
        });
        
        // Ordina ogni categoria una sola volta, al momento della creazione della cache
        Object.values(mealsByCategory).forEach(meals => {
            meals.sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
        });
        
        dailyMealsCache[dateKey] = mealsByCategory; // Salva in cache
    }
    
    // Se il contenitore principale è vuoto, lo costruiamo per la prima volta.
    if (mainContainer.innerHTML.trim() === '') {
        mainContainer.innerHTML = Object.keys(mealsByCategory).map(categoryName => `
            <div class="meal-category" data-category-name="${escapeText(categoryName)}">
                <div class="meal-category-header">
                    <h3 class="text-lg font-semibold text-slate-200">${escapeText(categoryName)}</h3>
                    <div class="text-xs md:text-sm font-medium text-slate-400 category-totals truncate mt-1">
                        <!-- I totali verranno aggiornati qui -->
                    </div>
                </div>
                <div class="category-tools"><button class="text-button" data-group-action="repeat">Ripeti da ieri</button><button class="text-button" data-group-action="save">Salva come abituale</button><button class="text-button" data-group-action="add">＋ Aggiungi</button></div>
                <div class="p-4 space-y-3 meal-list-container">
                    <!-- I pasti verranno renderizzati qui -->
                </div>
            </div>
        `).join('');
    }
    
    // Ora aggiorniamo ogni categoria individualmente senza distruggere la struttura.
    Object.entries(mealsByCategory).forEach(([categoryName, meals]) => {
        const categoryElement = mainContainer.querySelector(`.meal-category[data-category-name="${CSS.escape(categoryName)}"]`);
        if (!categoryElement) return; // Salta se l'elemento non esiste

        const listContainer = categoryElement.querySelector('.meal-list-container');
        const signature = JSON.stringify([meals.map(({ pending, ...meal }) => meal), meals.length ? null : dayLoadStates[dateKey]]);
        if (listContainer.dataset.signature === signature) return;
        listContainer.dataset.signature = signature;
        const totalsContainer = categoryElement.querySelector('.category-totals');
        const categoryTotals = emptyTotals();
        let mealsHTML = '';
        
        if (meals.length > 0) {
            // L'ordinamento è già stato fatto durante la creazione della cache
            mealsHTML = meals.map(meal => {
                const calculated = mealNutrition(meal);
                addTotals(categoryTotals, calculated);
                return `
                <div class="meal-item flex flex-col md:flex-row md:items-center p-4" data-id="${meal.id}">
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-slate-200 break-words">${escapeText(meal.name)}</p>
                        <p class="text-sm text-slate-300 mt-1">${escapeText(portionDescription(meal.portion) || `${formatAmount(meal.quantity || 0)} g`)}${meal.estimated ? ` · ${estimateLabel(meal)}` : ''}</p>
                        ${meal.estimate ? `<details class="meal-estimate-detail"><summary>${escapeText(estimateRange(meal))}</summary><p>${escapeText(estimateBreakdown(meal))}</p><p>Quantità e valori approssimativi. Nel totale è usata la stima centrale; l’intervallo è convenzionale.</p></details>` : ''}
                        ${meal.aiEstimate ? `<details class="meal-estimate-detail"><summary>Ipotesi della stima da descrizione</summary><p>${escapeText((meal.aiEstimate.assumptions || []).join(' '))}</p><p>${escapeText(meal.aiEstimate.notes || '')}</p>${meal.aiEstimate.edited ? '<p>Valori o nome corretti manualmente prima dell’inserimento.</p>' : ''}</details>` : ''}
                        <p class="text-xs md:text-sm text-slate-400 mt-1 meal-nutrition-details">
                            ${calculated.calories.toFixed(0)} kcal · P ${calculated.proteins.toFixed(1)} · C ${calculated.carbs.toFixed(1)} · G ${calculated.fats.toFixed(1)}
                        </p>
                    </div>
                    <div class="meal-actions flex-shrink-0">
                        <div class="flex items-center gap-2">
                            <button class="btn-modern bg-slate-600 !py-2 !px-3 edit-meal-btn" data-meal-id="${meal.id}" aria-label="Modifica pasto"><i class="fas fa-pencil-alt"></i></button>
                            <button class="btn-modern btn-danger !py-2 !px-3 delete-meal-btn" data-meal-id="${meal.id}" aria-label="Elimina pasto"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                </div>`;
            }).join('');
        } else {
            const emptyMessage = dayLoadStates[dateKey] === 'loading' ? 'Caricamento…' : dayLoadStates[dateKey] === 'cached' || dayLoadStates[dateKey] === 'error' ? 'Nessun pasto disponibile sul dispositivo' : 'Nessun pasto registrato';
            mealsHTML = `<div class="text-center text-slate-500 italic py-4">${emptyMessage}</div>`;
        }
        
        // Aggiorna solo il contenuto della lista e dei totali, preservando la struttura.
        listContainer.innerHTML = mealsHTML;
        totalsContainer.innerHTML = `${categoryTotals.calories.toFixed(0)} kcal`;


    });
    
    // initSortableLists();
    updateNutritionProgress();
}

function renderRecipes() {
    const container = document.getElementById('saved-recipes');
    if (recipes.length === 0) {
        container.innerHTML = `<div class="text-center text-slate-400 py-8"><i class="fas fa-book-open text-3xl mb-3 opacity-50"></i><p>Nessuna ricetta salvata</p></div>`;
        return;
    }
    container.innerHTML = recipes.map(recipe => {
        let macroBarHTML = '';
        if (recipe.totalNutrition) {
            const proteinCalories = (recipe.totalNutrition.proteins || 0) * 4;
            const carbCalories = (recipe.totalNutrition.carbs || 0) * 4;
            const fatCalories = (recipe.totalNutrition.fats || 0) * 9;
            const totalMacroCalories = proteinCalories + carbCalories + fatCalories;

            if (totalMacroCalories > 0) {
                const proteinPerc = (proteinCalories / totalMacroCalories) * 100;
                const carbPerc = (carbCalories / totalMacroCalories) * 100;
                const fatPerc = (fatCalories / totalMacroCalories) * 100;

                macroBarHTML = `
                <div class="mt-4">
                    <p class="text-sm font-medium text-slate-300 mb-2">Distribuzione Macro (Calorie)</p>
                    <div class="flex h-4 rounded-md overflow-hidden bg-slate-700 shadow-inner">
                        <div class="transition-all duration-500" style="background: var(--macro-protein); width: ${proteinPerc.toFixed(2)}%;" title="Proteine: ${proteinPerc.toFixed(0)}%"></div>
                        <div class="transition-all duration-500" style="background: var(--macro-carbs); width: ${carbPerc.toFixed(2)}%;" title="Carboidrati: ${carbPerc.toFixed(0)}%"></div>
                        <div class="transition-all duration-500" style="background: var(--macro-fat); width: ${fatPerc.toFixed(2)}%;" title="Grassi: ${fatPerc.toFixed(0)}%"></div>
                    </div>
                    <div class="flex justify-between text-xs mt-1 text-slate-400 px-1">
                        <span>P: ${proteinPerc.toFixed(0)}%</span>
                        <span>C: ${carbPerc.toFixed(0)}%</span>
                        <span>G: ${fatPerc.toFixed(0)}%</span>
                    </div>
                </div>`;
            }
        }

        return `
        <div class="recipe-card" data-id="${recipe.id}">
            <div class="flex justify-between items-start">
                <div>
                    <h4 class="font-bold text-lg text-slate-200 mb-3">${escapeText(recipe.name)} ${recipe.servings > 1 ? `(${recipe.servings} porzioni)` : ''}</h4>
                    <ul class="mt-2 text-sm text-slate-400 list-disc pl-5 space-y-1">
                        ${recipe.ingredients.map(ing => `<li>${escapeText(ing.name)}: ${escapeText(ing.quantity)}g</li>`).join('')}
                    </ul>
                    ${(recipe.totalNutrition && recipe.totalWeight && recipe.servings) ? `
                    <div class="mt-4 pt-4 border-t border-slate-700">
                        <p class="font-semibold text-slate-300 mb-2">Per porzione${positive(recipe.finalWeight) ? ` (${formatAmount(recipe.finalWeight / recipe.servings)} g)` : ' · peso finale non registrato'}:</p>
                        <p class="text-sm text-slate-400">
                            Cal: ${(recipe.totalNutrition.calories / recipe.servings).toFixed(0)} | P: ${(recipe.totalNutrition.proteins / recipe.servings).toFixed(1)}g | C: ${(recipe.totalNutrition.carbs / recipe.servings).toFixed(1)}g | G: ${(recipe.totalNutrition.fats / recipe.servings).toFixed(1)}g | F: ${(recipe.totalNutrition.fibers / recipe.servings).toFixed(1)}g
                        </p>
                        ${macroBarHTML}
                    </div>
                    ` : ''}
                </div>
                <div class="recipe-actions">
                    <div class="flex items-center gap-3">
                        <button class="btn-modern btn-primary !py-2 !px-3 use-recipe-btn" data-recipe-id="${recipe.id}" aria-label="Usa ricetta">
                            <i class="fas fa-plus"></i>
                        </button>
                        <button class="btn-modern bg-slate-600 !py-2 !px-3 edit-recipe-btn" data-recipe-id="${recipe.id}" aria-label="Modifica ricetta">
                            <i class="fas fa-pencil-alt"></i>
                        </button>
                        <button class="btn-modern btn-danger !py-2 !px-3 delete-recipe-btn" data-recipe-id="${recipe.id}" aria-label="Elimina ricetta">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `}).join('');
}

function renderWeeklyHistory() {
    const container = document.getElementById('weekly-history');
    container.innerHTML = '';
    const today = new Date(selectedDate);
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today); // Crea una copia di "oggi"
        date.setUTCDate(today.getUTCDate() - i); // Sottrai i giorni dalla data fissata
        const dateKey = date.toISOString().split('T')[0];
        const totals = dailyTotalsCache[dateKey] || { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        const isToday = dateKey === dayKey(getTodayUTC());
        const dateClass = isToday ? 'font-bold text-indigo-400' : '';
        
        const row = document.createElement('tr');
        row.className = 'table-row history-row';
        row.dataset.date = date.toISOString();
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm ${dateClass}">${date.toLocaleDateString('it-IT', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })} ${isToday ? '(Oggi)' : ''}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.calories.toFixed(0)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.proteins.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.carbs.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.fats.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.fibers.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${waterHistory[dateKey] || 0} bicchieri</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-400">${dailyMealsCache[dateKey] ? Object.values(dailyMealsCache[dateKey]).length : 0} pasti</td>
        `;
        if (!dailyTotalsCache[dateKey]) {
            [...row.children].slice(1, 6).forEach(cell => cell.textContent = '—');
        }
        row.lastElementChild.textContent = `${allMeals.filter(meal => dayKey(meal.jsDate) === dateKey).length} alimenti`;
        row.tabIndex = 0;
        row.setAttribute('aria-label', `Apri ${formatDate(date)}`);
        const openDay = () => { selectedDate = new Date(date); mealEntry.close(); handleDayChange(); };
        row.addEventListener('click', openDay);
        row.addEventListener('keydown', event => { if (event.key === 'Enter') openDay(); });
        container.appendChild(row);
    }
}

function updateNutritionProgress() {
    const dateKey = selectedDate.toISOString().split('T')[0];
    const totals = dailyTotalsCache[dateKey] || { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };    
    const { start, end } = getDayBounds(selectedDate);
    const dayMeals = allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end);
    
    // Aggiorna i totali principali
    const updateAndAnimateTotal = (id, value, decimals = 0) => {
        // FIX: Aggiunto controllo per valori non numerici per prevenire crash.
        const numericValue = Number(value);
        if (isNaN(numericValue)) {
            console.warn(`Tentativo di aggiornare ${id} con un valore non valido:`, value);
            return; // Interrompe l'aggiornamento se il valore non è un numero
        }
        const element = document.getElementById(id);
        const text = numericValue.toFixed(decimals);
        if (element.textContent !== text) { element.textContent = text; triggerFlashAnimation(id); }
    };

    document.getElementById('diary-energy-goal').textContent = `Obiettivo: ${nutritionGoals.calories} kcal`;
    document.getElementById('diary-energy-progress').value = Math.min(100, totals.calories / (nutritionGoals.calories || 1) * 100);
    updateAndAnimateTotal('total-calories', totals.calories, 0);
    updateAndAnimateTotal('total-proteins', totals.proteins, 1);
    updateAndAnimateTotal('total-carbs', totals.carbs, 1);
    updateAndAnimateTotal('total-fats', totals.fats, 1);
    updateAndAnimateTotal('total-fibers', totals.fibers, 1);

    // Aggiorna le barre di progresso
    const updateProgress = (type, value) => {
        // FIX: Aggiunto controllo per valori non numerici.
        const numericValue = Number(value);
        if (isNaN(numericValue)) {
            console.warn(`Valore non valido per la barra di progresso ${type}:`, value);
            return; // Non aggiornare la barra se il valore è invalido
        }
        const percent = Math.min(100, (numericValue / (nutritionGoals[type] || 1)) * 100); // Evita divisione per zero
        document.getElementById(`${type}-progress`).style.width = `${percent}%`;
        document.getElementById(`${type}-progress`).parentElement.setAttribute('aria-valuenow', String(percent));
        document.getElementById(`${type}-progress-text`).textContent = `${value.toFixed(type === 'calories' ? 0 : 1)}${type !== 'calories' ? 'g' : ''} / ${nutritionGoals[type]}${type !== 'calories' ? 'g' : ''}`;
    };

    updateProgress('calories', totals.calories);
    updateProgress('proteins', totals.proteins);
    updateProgress('carbs', totals.carbs);
    updateProgress('fats', totals.fats);
    updateProgress('fibers', totals.fibers);
    
    updateMealDistributionBar(dayMeals);
    updateMacroDistributionBar();
}

function updateMealDistributionBar(dayMeals) {
    const mealTypes = {
        '🌅 Colazione': { bar: 'meal-dist-colazione', perc: 'meal-dist-colazione-perc', calories: 0 },
        '🍽️ Pranzo': { bar: 'meal-dist-pranzo', perc: 'meal-dist-pranzo-perc', calories: 0 },
        '🌙 Cena': { bar: 'meal-dist-cena', perc: 'meal-dist-cena-perc', calories: 0 },
        '🍪 Spuntino': { bar: 'meal-dist-spuntino', perc: 'meal-dist-spuntino-perc', calories: 0 }
    };

    let totalDayCalories = 0;

    dayMeals.forEach(meal => {
        const mealCalories = ((Number(meal.calories) || 0) * (Number(meal.quantity) || 0) / 100);
        if (mealTypes[meal.type]) {
            mealTypes[meal.type].calories += mealCalories;
        }
        totalDayCalories += mealCalories;
    });

    if (totalDayCalories === 0) {
        // Se non ci sono calorie, resetta la barra
        Object.values(mealTypes).forEach(type => {
            document.getElementById(type.bar).style.width = '0%';
            document.getElementById(type.bar).textContent = '';
            document.getElementById(type.perc).textContent = '0%';
        });
        return;
    }

    Object.values(mealTypes).forEach(type => {
        const percentage = (type.calories / totalDayCalories) * 100;
        const barElement = document.getElementById(type.bar);
        const percElement = document.getElementById(type.perc);

        barElement.style.width = `${percentage.toFixed(2)}%`;
        barElement.textContent = percentage > 10 ? `${percentage.toFixed(0)}%` : '';
        percElement.textContent = `${percentage.toFixed(0)}%`;
    });
}


function updateMacroDistributionBar() {
    const proteinBar = document.getElementById('macro-dist-proteins');
    const carbBar = document.getElementById('macro-dist-carbs');
    const fatBar = document.getElementById('macro-dist-fats');
    
    const proteinPercText = document.getElementById('macro-dist-proteins-perc');
    const carbPercText = document.getElementById('macro-dist-carbs-perc');
    const fatPercText = document.getElementById('macro-dist-fats-perc');

    if (!proteinBar || !carbBar || !fatBar) return; // Safety check

    // Usa gli obiettivi nutrizionali invece dei totali giornalieri
    const proteinCalories = (nutritionGoals.proteins || 0) * 4;
    const carbCalories = (nutritionGoals.carbs || 0) * 4;
    const fatCalories = (nutritionGoals.fats || 0) * 9;

    const totalMacroCalories = proteinCalories + carbCalories + fatCalories;

    if (totalMacroCalories === 0) {
        proteinBar.style.width = '33.33%';
        carbBar.style.width = '33.33%';
        fatBar.style.width = '33.34%';
        [proteinBar, carbBar, fatBar].forEach(el => el.textContent = '');
        [proteinPercText, carbPercText, fatPercText].forEach(el => el.textContent = '0%');
        return;
    }

    const proteinPerc = (proteinCalories / totalMacroCalories) * 100;
    const carbPerc = (carbCalories / totalMacroCalories) * 100;
    const fatPerc = (fatCalories / totalMacroCalories) * 100;

    proteinBar.style.width = `${proteinPerc.toFixed(2)}%`;
    carbBar.style.width = `${carbPerc.toFixed(2)}%`;
    fatBar.style.width = `${fatPerc.toFixed(2)}%`;

    proteinBar.textContent = proteinPerc > 10 ? `${proteinPerc.toFixed(0)}%` : '';
    carbBar.textContent = carbPerc > 10 ? `${carbPerc.toFixed(0)}%` : '';
    fatBar.textContent = fatPerc > 10 ? `${fatPerc.toFixed(0)}%` : '';

    proteinPercText.textContent = `${proteinPerc.toFixed(0)}%`;
    carbPercText.textContent = `${carbPerc.toFixed(0)}%`;
    fatPercText.textContent = `${fatPerc.toFixed(0)}%`;
}

function renderWaterTracker() {
    const container = document.getElementById('water-glasses-container');
    const text = document.getElementById('water-count-text');
    if (!container || !text) return;

    const goal = nutritionGoals.water;
    const existingGlasses = container.children;

    // Aggiunge o rimuove bicchieri solo se il numero obiettivo è cambiato
    while (existingGlasses.length < goal) {
        const glass = document.createElement('i');
        glass.className = 'fas fa-glass-water water-glass';
        glass.setAttribute('aria-hidden', 'true');
        container.appendChild(glass);
    }
    while (existingGlasses.length > goal) {
        container.removeChild(container.lastChild);
    }

    // Aggiorna solo la classe filled senza ricreare gli elementi (evita il flickering)
    Array.from(existingGlasses).forEach((glass, i) => {
        const shouldBeFilled = i < waterCount;
        glass.classList.toggle('filled', shouldBeFilled);
    });

    text.textContent = `${waterCount} / ${goal} bicchieri`;

    // Aggiorna la barra di progresso nella sezione Obiettivi
    const waterProgressText = document.getElementById('water-progress-text');
    const waterProgressBar = document.getElementById('water-progress');
    const waterTotalMl = document.getElementById('water-total-ml');
    
    if (waterProgressText && waterProgressBar) {
        const goal = nutritionGoals.water || 8;
        const percent = goal > 0 ? Math.min(100, (waterCount / goal) * 100) : 0;
        
        waterProgressBar.style.width = `${percent}%`;
        waterProgressText.textContent = `${waterCount}/${goal} bicchieri`;

        if (waterTotalMl) {
            const totalMl = waterCount * 200;
            waterTotalMl.textContent = `(${totalMl}mL)`;
        }
    }
}

/*
function initSortableLists() {
    const mealLists = document.querySelectorAll('.meal-list-container');
    mealLists.forEach(list => {
        // Previene la ri-inizializzazione se l'istanza esiste già
        if (list.sortableInstance) {
            list.sortableInstance.destroy();
        }

        // Crea una nuova istanza di Sortable
        list.sortableInstance = new Sortable(list, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            onStart: () => {
                // isDragging = true;
            },
            onEnd: async (evt) => {
                // isDragging = false; // Resetta il flag

                // Ottiene gli elementi nella loro nuova posizione
                const items = Array.from(evt.from.children);

                // Crea un array di aggiornamenti con ID e nuovo indice
                const updates = items.map((item, index) => ({
                    id: item.dataset.id,
                    newIndex: index
                })).filter(u => u.id);

                if (updates.length > 0) {
                    await updateMealOrder(updates);
                }
            }
        });
    });
}
*/

/* async function updateMealOrder(updates) {
    if (!userId || !isOnline) {
        showToast("Sei offline. Impossibile riordinare.", true);
        renderSelectedDayMeals(); // Ripristina l'ordine visivo
        return;
    }

    try {
        const batch = writeBatch(db);
        updates.forEach(update => {
            const mealRef = doc(db, `users/${userId}/meals`, update.id);
            batch.update(mealRef, { sortIndex: update.newIndex });
        });
        await batch.commit();
        showToast('Ordine dei pasti aggiornato!');
    } catch (error) {
        console.error("Errore durante l'aggiornamento dell'ordine dei pasti:", error);
        showToast("Errore durante il riordino.", true);
    }
} */


// --- FUNZIONI UTILITY E HELPERS ---

async function handleDayChange() {
    updateAllUI();
    listenToMeals();
    listenToWaterData();
    listenToWaterHistory();
}

function changeDay(offset) {
    if (offset === 0) { // Vai a oggi
        selectedDate = getTodayUTC();
    } else {
        selectedDate.setUTCDate(selectedDate.getUTCDate() + offset);
    }
    handleDayChange();
}

function handleDateChange(e) {
    if (!e.target.value) return;
    const [year, month, day] = e.target.value.split('-').map(Number);
    // BUG FIX: Usa Date.UTC per creare la data. Questo previene problemi di fuso orario
    // dove il browser potrebbe interpretare la data come il giorno precedente.
    // new Date("2024-05-25") può diventare 24 Maggio 22:00 UTC in alcuni fusi orari.
    selectedDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    handleDayChange();
}

function resetAppData() {
    estimateEditor?.close();
    dishEstimateEditor?.reset();
    editedMealEstimate = null;
    writeTracker.reset();
    snapshotPending = false; waterPending = false; habitsPending = false; restoredWritesPending = false;
    dayLoadStates = {};
    dailyTotalsCache = {};
    habitualUnsubscribe?.(); habitualUnsubscribe = null; habitualMeals = [];
    mealListenerGeneration++;
    chartsReady = false;
    document.getElementById('habitual-meals').replaceChildren();
    document.getElementById('undo-notices').replaceChildren();
    closeMealGroup();
    hideConfirmationModal();
    document.getElementById('edit-meal-modal').classList.add('hidden');
    mealToEditId = null;

    resetAddMealForm();
    allMeals = [];
    nutritionGoals = { calories: 2000, proteins: 150, carbs: 250, fats: 70, fibers: 30, water: 8 };
    recipes = [];
    dailyMealsCache = {}; // Pulisce la cache al logout
    destroyCharts();
    document.getElementById('selected-day-meals').innerHTML = '';
    if (mealsUnsubscribe) { mealsUnsubscribe(); mealsUnsubscribe = null; }
    if (recipesUnsubscribe) { recipesUnsubscribe(); recipesUnsubscribe = null; }
    if (favoriteMealsUnsubscribe) { favoriteMealsUnsubscribe(); favoriteMealsUnsubscribe = null; }
    if (waterHistoryUnsubscribe) { waterHistoryUnsubscribe(); waterHistoryUnsubscribe = null; }
    if (waterUnsubscribe) { waterUnsubscribe(); waterUnsubscribe = null; }
    document.getElementById('saved-recipes').innerHTML = '';
    document.getElementById('weekly-history').innerHTML = '';
    favoriteMeals = [];
    selectedFood = null;
    foods = [];
    portionPicker.select();
    document.getElementById('food-search').value = '';
    updateMealPreview();
    renderRecentPortions();
    updateFavoriteMealsUI();
}

function showFoodLookupDetails(food) {
    const detailsContainer = document.getElementById('food-lookup-details');
    const detailsList = document.getElementById('lookup-food-details-list'); // Assicurati che questo ID esista nell'HTML
    document.getElementById('lookup-food-name').textContent = food.name;
    const editBtn = document.getElementById('edit-lookup-food-btn');
    editBtn.dataset.foodId = food.id;
    editBtn.classList.remove('hidden');

    // Pulisce la lista precedente
    detailsList.innerHTML = '';

    let htmlContent = '';
    groupNutrientDetails(food).forEach(group => {
        htmlContent += `<li class="nutrient-group-header col-span-full">${group.title}</li>`;
        group.items.forEach(item => {
            const displayName = item.name || item.key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const unit = item.unit ? ` ${item.unit}` : '';
            const icon = item.icon || 'fa-atom text-gray-400';
            
            htmlContent += `
                <li>
                    <i class="fas ${icon} w-5 text-center mr-2" aria-hidden="true"></i>
                    <strong>${escapeText(displayName)}:</strong> 
                    <span>${escapeText(item.value)}${unit}</span>
                </li>`;
        });
    });

    if (htmlContent === '') {
        detailsList.innerHTML = `<li class="col-span-full text-slate-400">Nessun dato nutrizionale dettagliato disponibile per questo alimento.</li>`;
    } else {
        detailsList.innerHTML = htmlContent;
    }
    detailsContainer.classList.remove('hidden');
}

async function setWaterCount(newCount) {
    const count = Math.max(0, Number(newCount));
    if (!Number.isFinite(count) || !userId) return;
    const ref = doc(db, `users/${userId}/water`, dayKey(selectedDate));
    waterCount = count; renderWaterTracker();
    queueWrite(() => setDoc(ref, { count }, { merge: true }), 'Salvataggio dell’acqua', undefined, ref.path);
}
async function incrementWaterCount(amount) { return setWaterCount(waterCount + amount); }

function listenToWaterData() {
    if (waterUnsubscribe) {
        waterUnsubscribe();
    }
    if (!userId) {
        waterCount = 0;
        renderWaterTracker();
        return;
    }

    const dateString = selectedDate.toISOString().split('T')[0];
    const owner = userId;
    const waterDocRef = doc(db, `users/${owner}/water`, dateString);

    waterUnsubscribe = onSnapshot(waterDocRef, { includeMetadataChanges: true }, (doc) => {
        if (dayKey(selectedDate) !== dateString || userId !== owner) return;
        waterPending = doc.metadata.hasPendingWrites;
        const data = doc.data();
        const newCount = data?.count || 0;
        waterCount = newCount; // Aggiorna il valore globale
        renderWaterTracker();
        renderSyncStatus();
    }, (error) => {
        if (dayKey(selectedDate) !== dateString || userId !== owner) return;
        console.error("Errore nel listener dell'acqua:", error);
        waterCount = 0;
        renderWaterTracker();
    });
}

function listenToWaterHistory() {
    if (waterHistoryUnsubscribe) {
        waterHistoryUnsubscribe();
    }
    if (!userId) return;

    const owner = userId;
    const selectedKey = dayKey(selectedDate);
    const dateString = dayKey(weekDates(selectedDate)[0]);

    const waterQuery = query(
        collection(db, `users/${userId}/water`),
        where(documentId(), '>=', dateString), where(documentId(), '<=', dayKey(selectedDate))
    );

    waterHistoryUnsubscribe = onSnapshot(waterQuery, (snapshot) => {
        if (userId !== owner || dayKey(selectedDate) !== selectedKey) return;
        const newHistory = {};
        snapshot.forEach(doc => {
            newHistory[doc.id] = doc.data().count;
        });
        waterHistory = newHistory;
        if (mealEntry?.currentView() === 'library') renderWeeklyHistory();
    }, (error) => {
        console.error("Errore nel listener dello storico acqua:", error);
    });
}
// ... (altre funzioni di UI come modali, form resets, grafici, etc.)
// ... (tutte le altre funzioni da qui in poi)

function openEditMealModal(mealId) {
    const meal = allMeals.find(m => m.id === mealId);
    if (!meal) {
        showToast("Pasto non trovato. Potrebbe essere stato eliminato.", true);
        return;
    }

    mealToEditId = mealId;
    editedMealEstimate = null;
    document.getElementById('edit-saved-estimate-btn').classList.toggle('hidden', !meal.estimate);

    const standardFields = document.getElementById('edit-standard-meal-fields');
    const customFields = document.getElementById('edit-custom-meal-fields');

    document.getElementById('edit-meal-name-input').value = meal.name;
    document.getElementById('edit-meal-type').value = meal.type;

    standardFields.classList.remove('hidden');
    document.getElementById('edit-meal-quantity').value = meal.quantity;
    if (meal.isCustom) {
        customFields.classList.remove('hidden');
        document.getElementById('edit-meal-calories').value = meal.calories || '';
        document.getElementById('edit-meal-proteins').value = meal.proteins || '';
        document.getElementById('edit-meal-carbs').value = meal.carbs || '';
        document.getElementById('edit-meal-fats').value = meal.fats || '';
    } else {
        standardFields.classList.remove('hidden');
        customFields.classList.add('hidden');
        document.getElementById('edit-meal-quantity').value = meal.quantity;
    }

    const unitSelect = document.getElementById('edit-meal-unit');
    const original = meal.portion && positive(meal.portion.gramsPerUnit);
    unitSelect.innerHTML = `${original ? `<option value="original">${escapeText(meal.portion.label || 'Misura originale')}</option>` : ''}<option value="g">Grammi${meal.portion?.ingredientWeight ? ' di ingredienti' : ''}</option>`;
    unitSelect.value = original ? 'original' : 'g';
    unitSelect.dataset.previous = unitSelect.value;
    document.getElementById('edit-meal-quantity').value = original ? meal.quantity / meal.portion.gramsPerUnit : meal.quantity;
    updateEditPortionHint();
    document.getElementById('edit-meal-modal').classList.remove('hidden');
    document.getElementById('edit-meal-modal').classList.add('flex');
    document.getElementById('edit-meal-name-input').focus();
}

function openGoalsModal() {
    updateCalculatedCalories(); // Calcola subito all'apertura
    document.getElementById('goals-modal').classList.remove('hidden');
    document.getElementById('goals-modal').classList.add('flex');
    document.getElementById('goal-proteins').focus(); // Focus sul primo campo modificabile
}

function closeGoalsModal() {
    document.getElementById('goals-modal').classList.add('hidden');
    document.getElementById('goals-modal').classList.remove('flex');
    updateGoalsInputs(); // Ripristina i valori se si annulla
}

function updateGoalsInputs() {
    document.getElementById('goal-calories').value = nutritionGoals.calories;
    document.getElementById('goal-proteins').value = nutritionGoals.proteins;
    document.getElementById('goal-carbs').value = nutritionGoals.carbs;
    document.getElementById('goal-fats').value = nutritionGoals.fats;
    document.getElementById('goal-fibers').value = nutritionGoals.fibers;
    document.getElementById('goal-water').value = nutritionGoals.water;
}

function updateGoalsModalMacroDistributionBar(proteins, carbs, fats) {
    const proteinBar = document.getElementById('modal-macro-dist-proteins');
    const carbBar = document.getElementById('modal-macro-dist-carbs');
    const fatBar = document.getElementById('modal-macro-dist-fats');
    
    const proteinPercText = document.getElementById('modal-macro-dist-proteins-perc');
    const carbPercText = document.getElementById('modal-macro-dist-carbs-perc');
    const fatPercText = document.getElementById('modal-macro-dist-fats-perc');

    if (!proteinBar || !carbBar || !fatBar) return;

    const proteinCalories = (proteins || 0) * 4;
    const carbCalories = (carbs || 0) * 4;
    const fatCalories = (fats || 0) * 9;
    const totalMacroCalories = proteinCalories + carbCalories + fatCalories;

    if (totalMacroCalories === 0) {
        [proteinBar, carbBar, fatBar].forEach(el => { el.style.width = '33.33%'; el.textContent = ''; });
        [proteinPercText, carbPercText, fatPercText].forEach(el => el.textContent = '0%');
        return;
    }

    const proteinPerc = (proteinCalories / totalMacroCalories) * 100;
    const carbPerc = (carbCalories / totalMacroCalories) * 100;
    const fatPerc = (fatCalories / totalMacroCalories) * 100;

    proteinBar.style.width = `${proteinPerc.toFixed(2)}%`;
    carbBar.style.width = `${carbPerc.toFixed(2)}%`;
    fatBar.style.width = `${fatPerc.toFixed(2)}%`;

    proteinPercText.textContent = `${proteinPerc.toFixed(0)}%`;
    carbPercText.textContent = `${carbPerc.toFixed(0)}%`;
    fatPercText.textContent = `${fatPerc.toFixed(0)}%`;
}

function updateCalculatedCalories() {
    const proteins = parseFloat(document.getElementById('goal-proteins').value) || 0;
    const carbs = parseFloat(document.getElementById('goal-carbs').value) || 0;
    const fats = parseFloat(document.getElementById('goal-fats').value) || 0;

    const calculatedCalories = (proteins * 4) + (carbs * 4) + (fats * 9);
    
    document.getElementById('goal-calories').value = Math.round(calculatedCalories);

    // Aggiorna anche la barra di distribuzione nel modale
    updateGoalsModalMacroDistributionBar(proteins, carbs, fats);
}

async function saveAndCloseGoalsModal() {
    nutritionGoals.calories = parseInt(document.getElementById('goal-calories').value) || 2000;
    nutritionGoals.proteins = parseInt(document.getElementById('goal-proteins').value) || 150;
    nutritionGoals.carbs = parseInt(document.getElementById('goal-carbs').value) || 250;
    nutritionGoals.fats = parseInt(document.getElementById('goal-fats').value) || 70;
    nutritionGoals.fibers = parseInt(document.getElementById('goal-fibers').value) || 30;
    nutritionGoals.water = parseInt(document.getElementById('goal-water').value) || 8;
    await saveNutritionGoals();
    updateNutritionProgress();
    renderWaterTracker();
    document.getElementById('goals-modal').classList.add('hidden');
    showToast('Obiettivi aggiornati con successo!');
}

function showConfirmationModal(message, onConfirm) {
    document.getElementById('confirmation-message').textContent = message;
    onConfirmAction = onConfirm;
    document.getElementById('confirmation-modal').classList.remove('hidden');
    document.getElementById('confirmation-modal').classList.add('flex');
}

function hideConfirmationModal() {
    document.getElementById('confirmation-modal').classList.add('hidden');
    document.getElementById('confirmation-modal').classList.remove('flex');
    onConfirmAction = null;
}

function executeConfirmAction() {
    if (typeof onConfirmAction === 'function') {
        onConfirmAction();
    }
    hideConfirmationModal();
}

function markIngredientConfirmed(ingredientInput, isConfirmed) {
    const row = ingredientInput.closest('.ingredient-row');
    let indicator = row.querySelector('.ingredient-status');
    if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'ingredient-status text-xs font-medium ml-1';
        ingredientInput.parentElement.appendChild(indicator);
    }
    if (isConfirmed) {
        indicator.textContent = '✓';
        indicator.className = 'ingredient-status text-xs font-medium ml-1 text-green-400';
        ingredientInput.classList.remove('border-slate-600');
        ingredientInput.classList.add('border-green-500/50');
    } else {
        indicator.textContent = '';
        ingredientInput.classList.remove('border-green-500/50');
        ingredientInput.classList.add('border-slate-600');
    }
}

function setupIngredientSearch(ingredientInput) {
    const resultsContainer = ingredientInput.parentElement.querySelector('.recipe-ingredient-results');

    // Quando l'utente digita manualmente, resetta lo stato "confermato"
    ingredientInput.addEventListener('input', () => {
        delete ingredientInput.dataset.foodId;
        markIngredientConfirmed(ingredientInput, false);
    });

    setupSearchHandler({
        inputElement: ingredientInput,
        resultsContainer: resultsContainer,
        searchFunction: searchFoodsOnly,
        onResultClick: (item) => {
            ingredientInput.value = item.name;
            ingredientInput.dataset.foodId = item.id;
            // Memorizza i dati nutrizionali per il calcolo della ricetta
            ingredientInput.dataset.calories = item.calories || 0;
            ingredientInput.dataset.proteins = item.proteins || 0;
            ingredientInput.dataset.carbs = item.carbs || 0;
            ingredientInput.dataset.fats = item.fats || 0;
            ingredientInput.dataset.fibers = item.fibers || 0;
            markIngredientConfirmed(ingredientInput, true);
            updateRecipeBuilderMacroBar();
        },
        itemRenderer: (item) => `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" role="button" tabindex="0" data-item-id="${escapeText(item.id)}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${escapeText(item.name)}</div>
                    <div class="text-sm text-slate-400">${item.calories || 0} cal/100g</div>
                </div>
            </div>
        `
    });
}

function addIngredientRow() {
    const container = document.getElementById('recipe-ingredients');
    const newIngredient = document.createElement('div');
    newIngredient.className = 'ingredient-row flex gap-3 items-start';
    const currentIngredientId = `recipe-ingredient-name-${ingredientCounter++}`;
    newIngredient.innerHTML = `
        <div class="flex-1 relative">
            <input type="text" id="${currentIngredientId}" class="recipe-ingredient-name input-modern w-full" placeholder="Cerca ingrediente..." autocomplete="off">
            <div class="recipe-ingredient-results search-results mt-2 max-h-48 overflow-y-auto absolute w-full z-10 hidden"></div>
        </div>
        <input type="number" class="recipe-ingredient-quantity input-modern w-24" placeholder="g" aria-label="Quantità ingrediente">
        <button type="button" class="btn-modern btn-danger !py-2 !px-3 remove-ingredient-btn" aria-label="Rimuovi ingrediente">
            <i class="fas fa-trash"></i>
        </button>`;
    container.appendChild(newIngredient);
    const ingredientInput = newIngredient.querySelector('.recipe-ingredient-name');
    setupIngredientSearch(ingredientInput);
    ingredientInput.focus();
}

function processInitialMeals() {
    // Ordina i pasti per data una sola volta dopo il caricamento iniziale
    allMeals.sort((a, b) => b.jsDate - a.jsDate);
    recalculateDailyTotals();
}

function recalculateDailyTotals() {
    dailyTotalsCache = {};
    allMeals.forEach(meal => {
        const dateKey = meal.jsDate.toISOString().split('T')[0];
        dailyTotalsCache[dateKey] ??= emptyTotals();
        addTotals(dailyTotalsCache[dateKey], mealNutrition(meal));
    });
}


function resetAddMealForm(keepOpen = false, mealType = getDefaultMealTypeByTime()) {
    document.getElementById('food-search').value = '';
    const quantityInput = document.getElementById('meal-quantity');
    quantityInput.value = '';
    quantityInput.disabled = false;
    selectedFood = null;
    portionPicker.select();
    document.getElementById('search-results').style.display = 'none';
    updateMealPreview(); // Nasconde l'anteprima

    // Imposta il tipo di pasto in base all'orario corrente
    document.getElementById('meal-type').value = mealType;

    // Resetta anche il form del pasto personalizzato
    document.getElementById('custom-meal-name').value = '';
    document.getElementById('custom-meal-calories').value = '';
    document.getElementById('custom-meal-proteins').value = '';
    document.getElementById('custom-meal-carbs').value = '';
    document.getElementById('custom-meal-fats').value = '';
    document.getElementById('save-custom-meal-as-food').checked = false;
    if (isCustomMealMode) {
        toggleCustomMealForm(); // Torna alla modalità di ricerca
    }
    mealEntry?.reset(keepOpen);
    if (keepOpen) document.getElementById('food-search').focus();
}

function initializeMealTypeByTime() {
    // Imposta il tipo di pasto di default all'avvio dell'app
    document.getElementById('meal-type').value = getDefaultMealTypeByTime();
}

function resetNewFoodForm() {
    ['new-food-name', 'new-food-calories', 'new-food-proteins', 'new-food-carbs', 'new-food-fats', 'new-food-fibers']
        .forEach(id => document.getElementById(id).value = '');
    document.getElementById('new-food-name').focus();
}

async function openEditFoodModal() {
    const foodId = document.getElementById('edit-lookup-food-btn').dataset.foodId;
    if (!foodId) return showToast("Nessun alimento selezionato.", true);

    // Prima controlla la cache, poi fetcha da Firestore se necessario
    let food = foods.find(f => f.id === foodId);
    if (!food) {
        try {
            const foodDoc = await getDoc(doc(db, 'foods', foodId));
            if (!foodDoc.exists()) return showToast("Alimento non trovato.", true);
            food = { id: foodDoc.id, ...foodDoc.data() };
            foods.push(food); // Aggiunge alla cache per usi futuri
        } catch (error) {
            console.error("Errore nel caricare l'alimento:", error);
            return showToast("Errore nel caricare i dati dell'alimento.", true);
        }
    }

    foodToEditId = foodId;
    document.getElementById('edit-food-name').value = food.name;
    document.getElementById('edit-food-calories').value = food.calories || '';
    document.getElementById('edit-food-proteins').value = food.proteins || '';
    document.getElementById('edit-food-carbs').value = food.carbs || '';
    document.getElementById('edit-food-fats').value = food.fats || '';
    document.getElementById('edit-food-fibers').value = food.fibers || '';
    document.getElementById('edit-food-modal').classList.remove('hidden');
}

function resetRecipeForm() {
    document.getElementById('recipe-name').value = '';
    document.getElementById('recipe-servings').value = '1';
    document.getElementById('recipe-final-weight').value = '';
    const ingredientsContainer = document.getElementById('recipe-ingredients');
    ingredientsContainer.innerHTML = ''; // Svuota tutto
    addIngredientRow(); // Aggiunge la prima riga vuota
    document.getElementById('recipe-name').focus();
    updateRecipeBuilderMacroBar(); // Resetta la barra
}

function openRecipeEditor(recipeId) {
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) return showToast("Ricetta non trovata.", true);

    recipeToEditId = recipeId;

    // Popola i campi del form
    document.getElementById('recipe-name').value = recipe.name;
    document.getElementById('recipe-servings').value = recipe.servings;
    document.getElementById('recipe-final-weight').value = recipe.finalWeight || '';

    const ingredientsContainer = document.getElementById('recipe-ingredients');
    ingredientsContainer.innerHTML = ''; // Pulisci gli ingredienti esistenti

    recipe.ingredients.forEach(ing => {
        const newRow = document.createElement('div');
        newRow.className = 'ingredient-row flex gap-3 items-start';
        newRow.innerHTML = `
            <div class="flex-1 relative">
                <input type="text" class="recipe-ingredient-name input-modern w-full" placeholder="Cerca ingrediente..." autocomplete="off" value="${escapeText(ing.name)}" data-food-id="${escapeText(ing.foodId || '')}">
                <div class="recipe-ingredient-results search-results mt-2 max-h-48 overflow-y-auto absolute w-full z-10 hidden"></div>
            </div>
            <input type="number" class="recipe-ingredient-quantity input-modern w-24" placeholder="g" value="${escapeText(ing.quantity)}">
            <button type="button" class="btn-modern btn-danger !py-2 !px-3 remove-ingredient-btn"><i class="fas fa-trash"></i></button>
        `;
        ingredientsContainer.appendChild(newRow);

        // Set up search functionality for this ingredient input
        const ingredientInput = newRow.querySelector('.recipe-ingredient-name');
        setupIngredientSearch(ingredientInput);
        // Marca gli ingredienti pre-caricati come confermati (hanno già i dati nutrizionali)
        if (ing.foodId) {
            ingredientInput.dataset.calories = ing.calories || 0;
            ingredientInput.dataset.proteins = ing.proteins || 0;
            ingredientInput.dataset.carbs = ing.carbs || 0;
            ingredientInput.dataset.fats = ing.fats || 0;
            ingredientInput.dataset.fibers = ing.fibers || 0;
            markIngredientConfirmed(ingredientInput, true);
        }
    });

    // Cambia l'UI per la modalità di modifica
    document.querySelector('#recipes-content h3').textContent = 'Modifica Ricetta';
    const saveBtn = document.getElementById('save-recipe-btn');
    saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i> Salva Modifiche';

    // Aggiungi un pulsante "Annulla"
    const cancelButton = document.createElement('button');
    cancelButton.id = 'cancel-edit-recipe-btn';
    cancelButton.className = 'btn-modern bg-slate-600 w-full mt-4';
    cancelButton.innerHTML = '<i class="fas fa-times mr-2"></i> Annulla';
    cancelButton.onclick = exitRecipeEditMode;
    saveBtn.after(cancelButton);

    // Scrolla alla sezione ricette e aprila se è chiusa
    const recipeSection = document.getElementById('recipes-content').closest('.collapsible-section');
    if (recipeSection.classList.contains('collapsed')) {
        recipeSection.querySelector('.section-header').click();
    }
    recipeSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('recipe-name').focus();

    // Aggiorna la barra dei macro con i dati esistenti
    updateRecipeBuilderMacroBar();
}

function exitRecipeEditMode() {
    recipeToEditId = null;
    document.querySelector('#recipes-content h3').textContent = 'Crea Nuova Ricetta';
    const saveBtn = document.getElementById('save-recipe-btn');
    saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i> Salva Ricetta';

    const cancelButton = document.getElementById('cancel-edit-recipe-btn');
    if (cancelButton) cancelButton.remove();

    resetRecipeForm();
}

// --- Funzioni di ricerca ---

function setupSearchHandler({ inputElement, searchFunction, onResultClick, itemRenderer }) {
    let currentResults = [];
    let dropdown = null;
    let generation = 0;
    function close() {
        generation++;
        dropdown?._cleanup?.(); dropdown?.remove(); dropdown = null;
        inputElement.setAttribute('aria-expanded', 'false');
    }
    function render(results, message = '') {
        currentResults = results;
        if (!dropdown || !dropdown.isConnected) {
            dropdown?._cleanup?.();
            dropdown = document.createElement('div');
            dropdown.id = 'dynamic-search-results';
            dropdown.className = 'search-dropdown';
            const position = () => {
                const rect = inputElement.getBoundingClientRect();
                dropdown.style.top = `${rect.bottom + 4}px`;
                dropdown.style.left = `${rect.left}px`;
                dropdown.style.width = `${rect.width}px`;
                dropdown.style.maxHeight = `${Math.max(80, Math.min(300, window.innerHeight - rect.bottom - 16))}px`;
            };
            window.addEventListener('scroll', position, { passive: true, capture: true });
            window.addEventListener('resize', position, { passive: true });
            dropdown._cleanup = () => {
                window.removeEventListener('scroll', position, true);
                window.removeEventListener('resize', position);
            };
            dropdown.addEventListener('click', event => {
                const item = event.target.closest('.search-item');
                const chosen = item && currentResults.find(result => String(result.id) === item.dataset.itemId);
                if (chosen) { close(); onResultClick(chosen); }
            });
            dropdown.addEventListener('keydown', event => {
                const buttons = [...dropdown.querySelectorAll('.search-item')];
                const index = buttons.indexOf(event.target.closest('.search-item'));
                if (event.key === 'Escape') { close(); inputElement.focus(); }
                if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                    event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
                }
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); buttons[index]?.click(); }
            });
            document.body.append(dropdown); position();
        }
        dropdown.innerHTML = results.map(itemRenderer).join('') + (message ? `<p class="p-4 muted" role="status">${escapeText(message)}</p>` : '');
        inputElement.setAttribute('aria-expanded', 'true');
    }
    const remoteSearch = debounce(async (term, token) => {
        if (token !== generation) return;
        try {
            const results = await searchFunction(term);
            if (token !== generation || !inputElement.getClientRects().length || !dropdown?.isConnected) return;
            render(results, results.searchWarning || (results.length ? '' : 'Nessun risultato. Prova un altro nome.'));
        } catch {
            if (token === generation && inputElement.getClientRects().length && dropdown?.isConnected) render(currentResults, 'Ricerca online non disponibile. Risultati salvati sul dispositivo; riprova tra poco.');
        }
    }, 250);
    inputElement.addEventListener('input', () => {
        const term = normalizeQuery(inputElement.value);
        const token = ++generation;
        if (term.length < 2) { close(); return; }
        const onlyFoods = searchFunction === searchFoodsOnly;
        render(localSearch(term, onlyFoods), isOnline ? 'Cerco altri risultati…' : 'Risultati disponibili sul dispositivo');
        remoteSearch(term, token);
    });
    inputElement.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && dropdown) { event.preventDefault(); dropdown.querySelector('.search-item')?.focus(); }
        if (event.key === 'Escape') close();
    });
    document.addEventListener('click', event => {
        if (dropdown && !dropdown.contains(event.target) && event.target !== inputElement) close();
    });
}
function localSearch(term, onlyFoods = false) {
    const recent = readPortionHistory(localStorage, userId).map(entry => entry.food);
    const candidates = [...foods, ...recipes.map(recipe => ({ ...recipe, isRecipe: true })), ...recent, ...favoriteMeals.map(meal => ({ ...meal, isRecipe: false }))];
    const results = new Map();
    candidates.forEach(item => {
        if (onlyFoods && (item.isRecipe || item.recipeId)) return;
        const id = item.id || item.foodId || foodKey(item);
        if (!results.has(id)) results.set(id, { ...item, id });
    });
    return rankResults(results, term);
}

// Cerca alimenti su Firestore per prefisso del nome e per parola, e aggiorna la cache on-demand.
// I risultati vanno poi filtrati con matchesSearch: la query per parola usa una sola parola del termine.
async function fetchFoodMatches(searchTerm) {
    const queries = [query(
        collection(db, 'foods'),
        where('name_lowercase', '>=', searchTerm),
        where('name_lowercase', '<=', searchTerm + '\uf8ff'),
        limit(20)
    )];
    const token = queryToken(searchTerm);
    if (token) queries.push(query(collection(db, 'foods'), where('search_tokens', 'array-contains', token), limit(20)));
    const snapshots = await Promise.allSettled(queries.map(q => getDocs(q)));

    if (snapshots.every(result => result.status === 'rejected')) throw new Error('Ricerca online non disponibile');
    const matches = new Map();
    matches.partial = snapshots.some(result => result.status === 'rejected');
    snapshots.forEach(snapshot => {
        if (snapshot.status !== 'fulfilled') return;
        snapshot.value.docs.forEach(doc => {
            if (!matches.has(doc.id)) matches.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: false });
        });
    });
    matches.forEach((food, id) => {
        const index = foods.findIndex(f => f.id === id);
        if (index < 0) foods.push(food); else foods[index] = food;
    });
    return matches;
}

// Tiene solo i risultati che contengono tutte le parole e li ordina, con in testa gli alimenti usati più spesso.
function rankResults(results, searchTerm) {
    const matching = Array.from(results.values()).filter(item => matchesSearch(item, searchTerm));
    return sortResults(matching, searchTerm, buildUsageStats(allMeals)).slice(0, 20);
}

async function searchFoodsOnly(searchTerm) { return searchAvailableFoods(searchTerm, true); }
async function searchFoodsAndRecipes(searchTerm) { return searchAvailableFoods(searchTerm, false); }
async function searchAvailableFoods(searchTerm, onlyFoods) {
    const term = normalizeQuery(searchTerm);
    if (term.length < 2) return [];
    const results = await fetchFoodMatches(term);
    localSearch(term, onlyFoods).forEach(item => { if (!results.has(item.id)) results.set(item.id, item); });
    const ranked = rankResults(results, term);
    if (results.partial) ranked.searchWarning = 'Alcuni risultati online non sono disponibili. Puoi riprovare.';
    return ranked;
}

function updateRecipeBuilderMacroBar() {
    const container = document.getElementById('recipe-builder-macro-bar-container');
    const ingredientRows = document.querySelectorAll('#recipe-ingredients .ingredient-row');

    let totalProteinCalories = 0;
    let totalCarbCalories = 0;
    let totalFatCalories = 0;
    let validIngredientsCount = 0;

    ingredientRows.forEach(row => {
        const nameInput = row.querySelector('.recipe-ingredient-name');
        const quantityInput = row.querySelector('.recipe-ingredient-quantity');
        
        const quantity = parseFloat(quantityInput.value) || 0;
        const proteins = parseFloat(nameInput.dataset.proteins);
        const carbs = parseFloat(nameInput.dataset.carbs);
        const fats = parseFloat(nameInput.dataset.fats);

        if (quantity > 0 && !isNaN(proteins) && !isNaN(carbs) && !isNaN(fats)) {
            validIngredientsCount++;
            const ratio = quantity / 100;
            totalProteinCalories += proteins * 4 * ratio;
            totalCarbCalories += carbs * 4 * ratio;
            totalFatCalories += fats * 9 * ratio;
        }
    });

    if (validIngredientsCount === 0) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');

    const totalMacroCalories = totalProteinCalories + totalCarbCalories + totalFatCalories;

    const proteinPerc = totalMacroCalories > 0 ? (totalProteinCalories / totalMacroCalories) * 100 : 0;
    const carbPerc = totalMacroCalories > 0 ? (totalCarbCalories / totalMacroCalories) * 100 : 0;
    const fatPerc = totalMacroCalories > 0 ? (totalFatCalories / totalMacroCalories) * 100 : 0;

    document.getElementById('recipe-builder-macro-proteins').style.width = `${proteinPerc.toFixed(2)}%`;
    document.getElementById('recipe-builder-macro-carbs').style.width = `${carbPerc.toFixed(2)}%`;
    document.getElementById('recipe-builder-macro-fats').style.width = `${fatPerc.toFixed(2)}%`;

    document.getElementById('recipe-builder-macro-proteins-perc').textContent = `${proteinPerc.toFixed(0)}%`;
    document.getElementById('recipe-builder-macro-carbs-perc').textContent = `${carbPerc.toFixed(0)}%`;
    document.getElementById('recipe-builder-macro-fats-perc').textContent = `${fatPerc.toFixed(0)}%`;
}

function updateMealPreview() {
    const previewContainer = document.getElementById('meal-preview');
    const quantity = portionPicker.quantity();
    document.getElementById('edit-estimate-btn').classList.toggle('hidden', isCustomMealMode || !selectedFood?.estimate);
    document.getElementById('estimate-preview-detail').textContent = isCustomMealMode ? '' : selectedFood?.aiEstimate
        ? `Stima da descrizione. ${selectedFood.aiEstimate.assumptions.join(' ')}`
        : selectedFood?.estimate ? `${estimateRange(selectedFood, quantity)}. ${estimateBreakdown(selectedFood, quantity)}` : '';

    if ((!selectedFood && !isCustomMealMode) || !Number.isFinite(quantity) || quantity <= 0) {
        previewContainer.classList.add('hidden');
        return;
    }

    previewContainer.classList.remove('hidden');

    const ratio = quantity / 100;
    let foodData;
    try { foodData = isCustomMealMode
        ? Object.fromEntries(['calories', 'proteins', 'carbs', 'fats'].map(key => [key, Number(document.getElementById(`custom-meal-${key}`).value)]))
        : nutritionPer100g(selectedFood); }
    catch { previewContainer.classList.add('hidden'); return; }

    document.getElementById('preview-calories').textContent = ((foodData.calories || 0) * ratio).toFixed(0);
    document.getElementById('preview-proteins').textContent = `${((foodData.proteins || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-carbs').textContent = `${((foodData.carbs || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-fats').textContent = `${((foodData.fats || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-fibers').textContent = `${((foodData.fibers || 0) * ratio).toFixed(1)} g`;

    // Mostra/nascondi il bottone "Aggiungi ai preferiti" in base a se è già nei preferiti
    const addToFavoritesBtn = document.getElementById('add-to-favorites-btn');
    const isAlreadyFavorite = favoriteMeals.some(meal => meal.name === selectedFood?.name);
    addToFavoritesBtn.classList.toggle('hidden', isCustomMealMode);
    addToFavoritesBtn.textContent = isAlreadyFavorite ? 'Aggiorna preferito' : 'Salva porzione preferita';
}

// --- Funzioni Scanner ---

function populateMealForm(foodData) {
    selectMealFood(foodData);
    showToast(`Prodotto trovato: ${foodData.name}`);
}

function populateNewFoodForm(foodData) {
    const section = document.getElementById('new-food-content').closest('.collapsible-section');
    if (section.classList.contains('collapsed')) {
        section.querySelector('.section-header').click();
    }
    
    document.getElementById('new-food-name').value = foodData.name;
    document.getElementById('new-food-calories').value = Math.round(foodData.calories);
    document.getElementById('new-food-proteins').value = (foodData.proteins || 0).toFixed(1);
    document.getElementById('new-food-carbs').value = (foodData.carbs || 0).toFixed(1);
    document.getElementById('new-food-fats').value = (foodData.fats || 0).toFixed(1);
    document.getElementById('new-food-fibers').value = (foodData.fibers || 0).toFixed(1);
    
    showToast(`Dati di "${foodData.name}" importati. Controlla e salva.`);
    document.getElementById('new-food-name').focus();
}

// --- AI PHOTO ANALYSIS ---

let aiCurrentImageBase64 = null;
let aiCurrentMimeType = null;
let aiCurrentParsed = null;
let aiLastRawResponse = null;

function openAiPhotoModal() {
    const modal = document.getElementById('ai-photo-modal');
    resetAiModal();
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    const apiKey = getGeminiApiKey();
    document.getElementById('ai-api-key-section').classList.toggle('hidden', !!apiKey);
}

function closeAiPhotoModal() {
    photoGeneration++;
    document.getElementById('ai-photo-modal').classList.add('hidden');
    document.getElementById('ai-photo-modal').classList.remove('flex');
    resetAiModal();
}

function resetAiModal() {
    aiCurrentImageBase64 = null;
    aiCurrentMimeType = null;
    aiCurrentParsed = null;
    aiLastRawResponse = null;

    document.getElementById('ai-photo-placeholder').classList.remove('hidden');
    document.getElementById('ai-photo-placeholder').textContent = 'Tocca per scattare una foto o carica un’immagine (JPG, PNG, WebP).';
    document.getElementById('ai-photo-preview').classList.add('hidden');
    document.getElementById('ai-photo-preview').src = '';
    document.getElementById('ai-photo-input').value = '';
    document.getElementById('ai-analyze-btn').classList.add('hidden');
    document.getElementById('ai-loading').classList.add('hidden');
    document.getElementById('ai-results').classList.add('hidden');
    document.getElementById('ai-error').classList.add('hidden');
    document.getElementById('ai-followup-section').classList.add('hidden');
    document.getElementById('ai-user-answer').value = '';
    document.getElementById('ai-refine-btn').disabled = false;
    document.getElementById('ai-refine-btn').textContent = 'Aggiorna stima';
    document.getElementById('ai-macros-grid').innerHTML = '';
    document.getElementById('ai-notes').classList.add('hidden');
}

function handleSaveApiKey() {
    const input = document.getElementById('gemini-api-key-input');
    const key = input.value.trim();
    if (!key) {
        showToast('Inserisci una API key valida.', true);
        return;
    }
    saveGeminiApiKey(key);
    document.getElementById('ai-api-key-section').classList.add('hidden');
    input.value = '';
    showToast('API key salvata.');
}

async function handleAiPhotoSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    const generation = ++photoGeneration;
    resetAiModal();
    document.getElementById('ai-photo-placeholder').textContent = 'Preparazione foto…';
    try {
        const dataUrl = await preparePhoto(file);
        if (generation !== photoGeneration) return;
        aiCurrentMimeType = 'image/jpeg';
        aiCurrentImageBase64 = dataUrl.split(',')[1];
        document.getElementById('ai-photo-placeholder').classList.add('hidden');
        const preview = document.getElementById('ai-photo-preview');
        preview.src = dataUrl; preview.classList.remove('hidden');
        document.getElementById('ai-analyze-btn').classList.remove('hidden');
    } catch (error) {
        if (generation === photoGeneration) showAiError(error.message || 'Formato non supportato. Prova una foto JPEG o PNG.');
    }
}

async function handleAiAnalyze() {
    const generation = photoGeneration;
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        document.getElementById('ai-api-key-section').classList.remove('hidden');
        showToast('Inserisci prima la tua API key Gemini.', true);
        return;
    }
    if (!aiCurrentImageBase64) {
        showToast('Seleziona prima una foto.', true);
        return;
    }

    document.getElementById('ai-analyze-btn').classList.add('hidden');
    document.getElementById('ai-loading').classList.remove('hidden');
    document.getElementById('ai-results').classList.add('hidden');
    document.getElementById('ai-error').classList.add('hidden');

    try {
        const rawText = await analyzePhoto(apiKey, aiCurrentImageBase64, aiCurrentMimeType);
        if (generation !== photoGeneration) return;
        aiLastRawResponse = rawText;
        const parsed = parseResponse(rawText);
        aiCurrentParsed = parsed;
        renderAiResults(parsed);
    } catch (err) {
        if (generation !== photoGeneration) return;
        showAiError(err.message);
        document.getElementById('ai-analyze-btn').classList.remove('hidden');
    } finally {
        if (generation === photoGeneration) document.getElementById('ai-loading').classList.add('hidden');
    }
}

async function handleAiRefine() {
    const generation = photoGeneration;
    const apiKey = getGeminiApiKey();
    const answer = document.getElementById('ai-user-answer').value.trim();
    if (!answer) {
        showToast('Scrivi una risposta prima di aggiornare la stima.', true);
        return;
    }

    document.getElementById('ai-refine-btn').disabled = true;
    document.getElementById('ai-refine-btn').innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Aggiornamento...';
    document.getElementById('ai-error').classList.add('hidden');

    try {
        const rawText = await refineWithAnswer(
            apiKey,
            aiCurrentImageBase64,
            aiCurrentMimeType,
            aiLastRawResponse,
            answer
        );
        if (generation !== photoGeneration) return;
        aiLastRawResponse = rawText;
        const parsed = parseResponse(rawText);
        aiCurrentParsed = parsed;
        renderAiResults(parsed);
        document.getElementById('ai-user-answer').value = '';
    } catch (err) {
        if (generation === photoGeneration) showAiError(err.message);
    } finally {
        if (generation === photoGeneration) {
        document.getElementById('ai-refine-btn').disabled = false;
        document.getElementById('ai-refine-btn').innerHTML = '<i class="fas fa-sync mr-2"></i>Aggiorna stima';
        }
    }
}

function renderAiResults(parsed) {
    document.getElementById('ai-results').classList.remove('hidden');

    document.getElementById('ai-food-name').textContent = parsed.alimento || 'Alimento sconosciuto';

    const qty = positive(parsed.quantita_stimata_g) ? Number(parsed.quantita_stimata_g) : 0;
    document.getElementById('ai-quantity-correction').value = qty || '';
    document.getElementById('ai-use-data-btn').disabled = !positive(qty);
    document.getElementById('ai-food-quantity').textContent = `Quantità stimata: ~${qty}g`;

    const badge = document.getElementById('ai-confidence-badge');
    const conf = parsed.confidenza || 'bassa';
    const badgeColors = { alta: 'bg-green-800 text-green-200', media: 'bg-yellow-800 text-yellow-200', bassa: 'bg-red-800 text-red-200' };
    badge.className = `text-xs px-2 py-1 rounded-full font-semibold ml-2 flex-shrink-0 ${badgeColors[conf] || badgeColors.bassa}`;
    badge.textContent = `Confidenza: ${conf}`;

    const v = Object.fromEntries(Object.entries(parsed.valori_per_100g || {}).map(([key, value]) => [key, Number(value) * qty / 100]));
    const macros = [
        { label: 'Calorie', value: Math.round(v.calorie || 0), unit: 'kcal', color: 'text-red-400', icon: 'fa-fire-alt' },
        { label: 'Proteine', value: (v.proteine || 0).toFixed(1), unit: 'g', color: 'text-green-400', icon: 'fa-drumstick-bite' },
        { label: 'Carboidrati', value: (v.carboidrati || 0).toFixed(1), unit: 'g', color: 'text-yellow-400', icon: 'fa-bread-slice' },
        { label: 'Grassi', value: (v.grassi || 0).toFixed(1), unit: 'g', color: 'text-pink-400', icon: 'fa-bacon' },
        { label: 'Fibre', value: (v.fibre || 0).toFixed(1), unit: 'g', color: 'text-blue-400', icon: 'fa-seedling' },
    ];

    const grid = document.getElementById('ai-macros-grid');
    grid.innerHTML = macros.map(m => `
        <div class="bg-slate-800/50 rounded-lg p-3 text-center">
            <i class="fas ${m.icon} ${m.color} mb-1 text-sm"></i>
            <div class="font-bold text-slate-100">${m.value} <span class="text-xs text-slate-400">${m.unit}</span></div>
            <div class="text-xs text-slate-400">${m.label} nella porzione</div>
        </div>
    `).join('');

    const questions = parsed.domande_chiarimento || [];
    const followupSection = document.getElementById('ai-followup-section');
    if (questions.length > 0) {
        const list = document.getElementById('ai-questions-list');
        list.innerHTML = questions.map(q => `<li>${escapeText(q)}</li>`).join('');
        followupSection.classList.remove('hidden');
    } else {
        followupSection.classList.add('hidden');
    }

    const notesEl = document.getElementById('ai-notes');
    if (parsed.note) {
        notesEl.textContent = parsed.note;
        notesEl.classList.remove('hidden');
    } else {
        notesEl.classList.add('hidden');
    }
}

function handleAiUseData() {
    if (!aiCurrentParsed) return;

    const v = aiCurrentParsed.valori_per_100g || {};
    const foodData = {
        name: aiCurrentParsed.alimento || 'Pasto da foto',
        calories: v.calorie || 0,
        proteins: v.proteine || 0,
        carbs: v.carboidrati || 0,
        fats: v.grassi || 0,
        fibers: v.fibre || 0,
        estimated: true,
    };

    if (!positive(aiCurrentParsed.quantita_stimata_g)) return showToast('Inserisci una quantità valida per la stima.', true);
    selectMealFood(foodData, { quantity: aiCurrentParsed.quantita_stimata_g });
    closeAiPhotoModal();
    showToast(`Dati di "${foodData.name}" importati dall'AI.`);
    document.getElementById('meal-quantity').focus();
}

function showAiError(message) {
    document.getElementById('ai-error-message').textContent = message;
    document.getElementById('ai-error').classList.remove('hidden');
}

function handleAiResetKey() {
    saveGeminiApiKey('');
    closeAiPhotoModal();
    openAiPhotoModal();
}

function editSavedEstimate() {
    const meal = editedMealEstimate || allMeals.find(item => item.id === mealToEditId);
    if (!meal?.estimate) return;
    const owner = userId, mealId = mealToEditId;
    let quantity;
    try { quantity = editPortion(meal, document.getElementById('edit-meal-quantity').value, document.getElementById('edit-meal-unit').value === 'original').quantity; }
    catch (error) { return showToast(error.message, true); }
    estimateEditor.open(meal, quantity, food => {
        if (owner !== userId || mealId !== mealToEditId) return;
        // Keep this as a draft until the parent edit form is explicitly saved.
        editedMealEstimate = food;
        const select = document.getElementById('edit-meal-unit');
        select.innerHTML = '<option value="original">Pasto stimato</option><option value="g">Grammi</option>';
        select.value = 'original'; select.dataset.previous = 'original';
        document.getElementById('edit-meal-quantity').value = 1;
        updateEditPortionHint();
    });
}
function changeEditUnit() {
    const meal = editedMealEstimate || allMeals.find(item => item.id === mealToEditId);
    if (!meal) return;
    const select = document.getElementById('edit-meal-unit');
    const amount = document.getElementById('edit-meal-quantity');
    if (positive(amount.value)) {
        const old = editPortion(meal, amount.value, select.dataset.previous === 'original');
        amount.value = old.quantity / (select.value === 'original' ? meal.portion.gramsPerUnit : 1);
    }
    select.dataset.previous = select.value;
    updateEditPortionHint();
}
function updateEditPortionHint() {
    const meal = editedMealEstimate || allMeals.find(item => item.id === mealToEditId);
    if (!meal) return;
    try {
        const edited = editPortion(meal, document.getElementById('edit-meal-quantity').value, document.getElementById('edit-meal-unit').value === 'original');
        document.getElementById('edit-portion-hint').textContent = `${portionDescription(edited.portion)}${meal.estimate ? ` · ${estimateRange(meal, edited.quantity)}` : ''}`;
    } catch { document.getElementById('edit-portion-hint').textContent = 'Inserisci una quantità maggiore di zero.'; }
}
function listenToHabitualMeals() {
    habitualUnsubscribe?.();
    const owner = userId;
    habitualUnsubscribe = onSnapshot(collection(db, `users/${owner}/habitualMeals`), { includeMetadataChanges: true }, snapshot => {
        if (owner !== userId) return;
        habitsPending = snapshot.metadata.hasPendingWrites; renderSyncStatus();
        habitualMeals = snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
        renderHabitualMeals();
    }, () => showToast('Impossibile caricare i pasti abituali.', true));
}
function renderHabitualMeals() {
    document.getElementById('habitual-meals').innerHTML = habitualMeals.length ? habitualMeals.map(group => `
        <div class="habitual-item"><div><strong>${escapeText(group.name)}</strong><p class="muted">${group.items.length} alimenti · ${escapeText(group.type)}</p></div>
        <button class="text-button" data-habit-use="${escapeText(group.id)}">Usa</button><button class="text-button" data-habit-delete="${escapeText(group.id)}" aria-label="Elimina ${escapeText(group.name)}">Elimina</button></div>
    `).join('') : '<p class="muted mt-3">Non hai ancora salvato un pasto abituale.</p>';
}
async function handleGroupAction(event) {
    const action = event.target.closest('[data-group-action]');
    if (!action || action.disabled) return;
    const type = action.closest('.meal-category').dataset.categoryName;
    if (action.dataset.groupAction === 'add') {
        resetAddMealForm(true, type); return;
    }
    const owner = userId;
    const targetDate = new Date(selectedDate);
    let meals = allMeals.filter(meal => dayKey(meal.jsDate) === dayKey(targetDate) && meal.type === type);
    if (action.dataset.groupAction === 'repeat') {
        const yesterday = new Date(targetDate); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        action.disabled = true;
        try {
            const { start, end } = getDayBounds(yesterday);
            const result = await getDocs(query(collection(db, `users/${owner}/meals`), where('date', '>=', Timestamp.fromDate(start)), where('date', '<=', Timestamp.fromDate(end))));
            if (userId !== owner || dayKey(selectedDate) !== dayKey(targetDate)) return;
            meals = result.docs.map(entry => entry.data()).filter(meal => meal.type === type);
            if (!meals.length && result.metadata.fromCache) return showToast('Nessun pasto di ieri disponibile sul dispositivo. Riprova con la rete.', true);
        } catch { showToast('Impossibile caricare i pasti di ieri. Riprova.', true); return; }
        finally { action.disabled = false; }
    }
    if (!meals.length) return showToast('Non ci sono alimenti da riutilizzare in questo pasto.');
    openMealGroup(meals, type, action.dataset.groupAction === 'save', targetDate, '', action);
}
function handleHabitualAction(event) {
    const use = event.target.closest('[data-habit-use]');
    const remove = event.target.closest('[data-habit-delete]');
    const group = habitualMeals.find(item => item.id === (use?.dataset.habitUse || remove?.dataset.habitDelete));
    if (!group) return;
    if (use) openMealGroup(group.items, group.type, false, new Date(selectedDate), group.name, use);
    const owner = userId;
    if (remove) showConfirmationModal(`Eliminare “${group.name}” dai pasti abituali?`, () => {
        if (owner !== userId) return;
        const ref = doc(db, `users/${owner}/habitualMeals`, group.id);
        queueWrite(() => deleteDoc(ref), 'Eliminazione del pasto abituale');
    });
}
function openMealGroup(meals, type, save, date, name = '', trigger = null) {
    groupDraft = { items: meals.map(mealTemplate), type, save, date, owner: userId, trigger };
    document.getElementById('meal-group-title').textContent = save ? 'Salva un pasto abituale' : name || 'Ripeti il pasto';
    document.getElementById('meal-group-context').textContent = save ? 'Scegli gli alimenti e le quantità da ricordare.' : `Aggiungi a ${formatDate(date)}. Puoi cambiare le quantità.`;
    document.getElementById('meal-group-name-field').classList.toggle('hidden', !save);
    document.getElementById('meal-group-name').value = name;
    document.getElementById('meal-group-type').value = type;
    document.getElementById('meal-group-error').textContent = '';
    document.getElementById('save-meal-group').textContent = save ? 'Salva abituale' : 'Aggiungi al diario';
    document.getElementById('meal-group-items').innerHTML = groupDraft.items.map((item, index) => `
        <div class="group-item"><label><input type="checkbox" data-group-index="${index}" checked/> ${escapeText(item.name)}</label>
        <label class="muted">${escapeText(item.portion?.label || 'Grammi')}<input class="input-modern" aria-label="Quantità di ${escapeText(item.name)}" data-group-amount="${index}" type="number" min="0.01" step="any" value="${item.quantity / (positive(item.portion?.gramsPerUnit) ? item.portion.gramsPerUnit : 1)}"/></label></div>
    `).join('');
    const modal = document.getElementById('meal-group-modal'); modal.classList.remove('hidden'); modal.classList.add('flex');
    (save ? document.getElementById('meal-group-name') : document.getElementById('meal-group-type')).focus();
}
function closeMealGroup() {
    const trigger = groupDraft?.trigger;
    groupDraft = null;
    document.getElementById('meal-group-modal').classList.add('hidden');
    trigger?.focus();
}
function saveMealGroup() {
    if (!groupDraft || groupDraft.owner !== userId) return;
    try {
        const draft = groupDraft;
        const items = draft.items.flatMap((item, index) => {
            if (!document.querySelector(`[data-group-index="${index}"]`).checked) return [];
            return [{ ...item, ...editPortion(item, document.querySelector(`[data-group-amount="${index}"]`).value) }];
        });
        if (!items.length) throw new Error('Seleziona almeno un alimento.');
        const type = document.getElementById('meal-group-type').value;
        if (draft.save) {
            const name = document.getElementById('meal-group-name').value.trim();
            if (!name) throw new Error('Dai un nome al pasto abituale.');
            const ref = doc(collection(db, `users/${draft.owner}/habitualMeals`));
            queueWrite(() => setDoc(ref, { name, type, items }), 'Salvataggio del pasto abituale');
        } else {
            const entries = items.map((item, i) => ({ ref: doc(collection(db, `users/${draft.owner}/meals`)), data: { ...item, type, date: Timestamp.fromDate(getMealTimestamp(type, draft.date)), sortIndex: Date.now() + i } }));
            queueWrite(() => {
                const batch = writeBatch(db);
                entries.forEach(entry => batch.set(entry.ref, entry.data));
                return batch.commit();
            }, 'Aggiunta del pasto completo');
        }
        closeMealGroup();
        if (!draft.save) mealEntry.close();
        showToast(draft.save ? 'Pasto abituale salvato.' : 'Pasto aggiunto al diario.');
    } catch (error) { document.getElementById('meal-group-error').textContent = error.message; }
}
