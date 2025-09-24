// Importa le funzioni necessarie da Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, query, where, Timestamp, doc, deleteDoc, orderBy, getDocs, setDoc, getDoc, limit, runTransaction, documentId, writeBatch, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { debounce, getDayBounds, formatDate, getMealTimestamp, getTodayUTC } from './modules/utils.js';
import { showToast, triggerFlashAnimation } from './modules/uiHelpers.js';
import { initCharts, updateCharts, destroyCharts } from './modules/charts.js';
import { firebaseConfig } from './firebase-config.js';

// --- STATO GLOBALE DELL'APPLICAZIONE ---
let app, auth, db;
let userId = null;
let selectedFood = null;
let selectedDate = getTodayUTC();
let allMeals = [];
let dailyMealsCache = {}; // Cache per i pasti giornalieri raggruppati e ordinati
let dailyTotalsCache = {}; // Cache per i totali nutrizionali giornalieri
let foods = []; // Cache per tutti gli alimenti del database
let recipes = [];
let currentRecipeIngredientResults = [];
let mealToEditId = null; // ID del pasto attualmente in modifica
let isOnline = navigator.onLine;
let foodToEditId = null; // ID dell'alimento attualmente in modifica
let onDecodeCallback = null;
let html5QrCode = null;
let availableCameras = [];
let isCustomMealMode = false;
let currentCameraIndex = 0;
let waterCount = 0;
let isAppInitialized = false; // Flag per controllare se l'inizializzazione è completa
let recipeToEditId = null; // ID della ricetta in modifica
let onConfirmAction = null; // Callback per il modale di conferma
// let isDragging = false; // Flag per gestire il conflitto click/drag
let waterUnsubscribe = null;
let waterHistory = {}; // e.g., { '2024-05-24': 8, '2024-05-23': 6 }
let waterHistoryUnsubscribe = null;

let nutritionGoals = {
    calories: 2000,
    proteins: 150,
    carbs: 250,
    fats: 70,
    fibers: 30,
    water: 8 // Obiettivo di bicchieri d'acqua
};

let ingredientCounter = 0;

// --- INIZIALIZZAZIONE ---

// Usiamo DOMContentLoaded per garantire che tutti gli script (inclusi quelli con 'defer')
// siano stati caricati ed eseguiti prima di avviare l'app.
// Questo risolve la "race condition" con la libreria ZXing.
window.addEventListener('DOMContentLoaded', () => {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
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

                initCharts(
                    document.getElementById('calorie-chart').getContext('2d'),
                    document.getElementById('macro-chart').getContext('2d')
                );

                // Ora che tutti i dati sono caricati e processati, aggiorna l'intera UI.
                updateAllUI();
                
                // Avvia il listener per i dati dell'acqua del giorno corrente.
                listenToWaterData();

                // L'inizializzazione è completata con successo.
                isAppInitialized = true;

                // Avvia i listener in tempo reale SOLO ORA che l'app è pronta.
                // Questo previene il doppio caricamento e le race condition.
                listenToMeals();
                listenToRecipes();
                listenToWaterHistory();

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

function setupListeners() {
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
    document.getElementById('add-meal-btn').addEventListener('click', addMeal);

    // Modale di conferma generico
    document.getElementById('meal-quantity').addEventListener('input', updateMealPreview);
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

    // Search functionality setup
    const searchResultsContainer = document.getElementById('search-results');
    setupSearchHandler({
        inputElement: foodSearchInput,
        resultsContainer: searchResultsContainer,
        searchFunction: searchFoodsAndRecipes,
        onResultClick: (item) => {
            selectedFood = item;
            foodSearchInput.value = item.name;
            const quantityInput = document.getElementById('meal-quantity');
            if (item.isRecipe) {
                const servingWeight = item.totalWeight / item.servings;
                quantityInput.value = servingWeight.toFixed(0);
            } else {
                quantityInput.value = 100;
            }
            quantityInput.focus();
            updateMealPreview();
        },
        itemRenderer: (item) => {
            if (item.isRecipe) {
                const servingWeight = (item.totalWeight / item.servings).toFixed(0);
                return `
                <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" data-item-id="${item.id}">
                    <i class="fas fa-book text-orange-400 mr-3"></i>
                    <div>
                        <div class="font-medium text-slate-200">${item.name}</div>
                        <div class="text-sm text-slate-400">Ricetta - 1 porzione (~${servingWeight}g)</div>
                    </div>
                </div>`;
            }
            return `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" data-item-id="${item.id}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${item.name}</div>
                    <div class="text-sm text-slate-400">${item.calories} cal/100g</div>
                </div>
            </div>`;
        }
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
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" data-item-id="${item.id}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${item.name}</div>
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
    if (online) {
        showToast('Sei di nuovo online!', false);
        // Quando torno online, nascondo i pulsanti dei pasti che potrebbero essere rimasti attivi
        // per evitare stati visivi incoerenti.
        setTimeout(() => {
            document.querySelectorAll('.meal-item.is-active').forEach(item => item.classList.remove('is-active'));
        }, 1000);
    } else {
        showToast('Sei offline. Alcune funzionalità potrebbero non essere disponibili.', true);
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
        quantityInput.value = 100; // Imposta un valore di default
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
}


// --- FUNZIONI DI MANIPOLAZIONE DATI (Firebase, API) ---

async function loadInitialData() {
    if (!userId) return;

    try {
        // 1. Carica tutti i dati necessari in parallelo per velocizzare l'avvio.
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const foodsQuery = query(collection(db, 'foods'), orderBy('name_lowercase'));
        const mealsQuery = query(collection(db, `users/${userId}/meals`), where('date', '>=', Timestamp.fromDate(thirtyDaysAgo)), orderBy('date', 'desc'));
        const recipesQuery = collection(db, `users/${userId}/recipes`);

        const [foodsSnapshot, mealsSnapshot, recipesSnapshot, _] = await Promise.all([
            getDocs(foodsQuery),
            getDocs(mealsQuery),
            getDocs(recipesQuery),
            loadNutritionGoals() // Carica gli obiettivi in parallelo
        ]);

        foods = foodsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allMeals = mealsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), jsDate: doc.data().date.toDate() }));
        recipes = recipesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Ordina i pasti e calcola i totali una sola volta dopo il caricamento iniziale.
        processInitialMeals();
    } catch (error) {
        console.error("Errore durante il caricamento dei dati iniziali:", error);
        showToast("Errore nel caricare i dati.", true);
        // Rilancia l'errore per fermare l'inizializzazione e mostrare un messaggio all'utente.
        throw error;
    }
}

function listenToMeals() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const mealsQuery = query(collection(db, `users/${userId}/meals`), where('date', '>=', Timestamp.fromDate(thirtyDaysAgo)));
    
    onSnapshot(mealsQuery, (snapshot) => {
        // Aggiorna l'UI solo se l'app è già stata inizializzata.
        // Questo previene race conditions durante il caricamento iniziale,
        // ignorando il primo snapshot che contiene dati già caricati.
        if (isAppInitialized) {
            let needsUiUpdate = false;
            snapshot.docChanges().forEach((change) => {
                needsUiUpdate = true;
                const mealId = change.doc.id;
                const data = { ...change.doc.data(), jsDate: change.doc.data().date.toDate() };

                if (change.type === "added") {
                    // Aggiunge solo se non è già presente per evitare duplicati
                    if (!allMeals.some(m => m.id === mealId)) {
                        allMeals.push({ id: mealId, ...data });
                    }
                } else if (change.type === "modified") {
                    const index = allMeals.findIndex(m => m.id === mealId);
                    if (index > -1) allMeals[index] = { id: mealId, ...data };
                } else if (change.type === "removed") {
                    allMeals = allMeals.filter(m => m.id !== mealId);
                }
            });

            if (!needsUiUpdate) return;
            allMeals.sort((a, b) => b.jsDate - a.jsDate);
            
            // FIX: Invalidate the daily meals cache to force re-rendering with fresh data.
            dailyMealsCache = {};
            recalculateDailyTotals();
            updateAllUI();
        }    }, (error) => {
        console.error("Errore nel listener dei pasti (onSnapshot):", error);
        showToast("Errore nel caricare i pasti in tempo reale.", true);
    });
}

function listenToRecipes() {
    try {
        const recipesCollection = collection(db, `users/${userId}/recipes`);
        onSnapshot(recipesCollection, (snapshot) => {
            recipes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderRecipes();
        });
    } catch (error) {
        console.error("Errore nell'avvio del listener delle ricette:", error);
    }
}

async function loadNutritionGoals() {
    if (!userId || !isOnline) return;
    try {
        const goalsDoc = doc(db, `users/${userId}/goals/nutrition`);
        const docSnap = await getDoc(goalsDoc);
        if (docSnap.exists()) {
            const loadedGoals = docSnap.data();
            // Unisce gli obiettivi caricati con quelli di default per garantire che tutti i campi esistano
            nutritionGoals = { ...nutritionGoals, ...loadedGoals };
        } else {
            await setDoc(goalsDoc, nutritionGoals); // Salva gli obiettivi di default per i nuovi utenti
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

async function addMeal() {
    if (!isOnline) return showToast("Sei offline. Impossibile aggiungere.", true);
    
    const quantity = parseFloat(document.getElementById('meal-quantity').value);
    const mealType = document.getElementById('meal-type').value;
    let mealData;

    if (isCustomMealMode) {
        const name = document.getElementById('custom-meal-name').value.trim();
        const calories = parseFloat(document.getElementById('custom-meal-calories').value);
        const proteins = parseFloat(document.getElementById('custom-meal-proteins').value);
        const carbs = parseFloat(document.getElementById('custom-meal-carbs').value);
        const fats = parseFloat(document.getElementById('custom-meal-fats').value);
        const saveAsNewFood = document.getElementById('save-custom-meal-as-food').checked;

        if (!name || isNaN(calories) || isNaN(proteins) || isNaN(carbs) || isNaN(fats)) {
            return showToast('Compila tutti i campi del pasto personalizzato.', true);
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
        if (!selectedFood || isNaN(quantity) || quantity <= 0) {
            return showToast('Seleziona un alimento e inserisci una quantità valida.', true);
        }

        // Se l'alimento selezionato è una ricetta, gestiscila in modo specifico
        if (selectedFood.isRecipe) {
            const { totalNutrition, totalWeight, servings, name } = selectedFood;
            const nutritionPer100g = {
                calories: ((totalNutrition.calories || 0) / totalWeight) * 100,
                proteins: ((totalNutrition.proteins || 0) / totalWeight) * 100,
                carbs: ((totalNutrition.carbs || 0) / totalWeight) * 100,
                fats: ((totalNutrition.fats || 0) / totalWeight) * 100,
                fibers: ((totalNutrition.fibers || 0) / totalWeight) * 100,
            };
            
            // Sovrascrivi selectedFood con i dati per 100g, così il resto della funzione non cambia
            selectedFood = {
                ...nutritionPer100g,
                name: `${name} (1 porzione)`,
                recipeId: selectedFood.id
            };
        }

        mealData = { ...selectedFood, quantity, type: mealType, isCustom: false };
    }

    if (!mealData) {
        return showToast("Dati del pasto non validi.", true);
    }

    const addBtn = document.getElementById('add-meal-btn');
    const originalBtnHTML = addBtn.innerHTML;

    try {
        addBtn.disabled = true;
        addBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Aggiungo...`;

        const mealDate = getMealTimestamp(mealType, selectedDate);

        const { start, end } = getDayBounds(selectedDate);
        const mealsOnDayQuery = query(
            collection(db, `users/${userId}/meals`),
            where('date', '>=', Timestamp.fromDate(start)),
            where('date', '<=', Timestamp.fromDate(end))
        );
        const querySnapshot = await getDocs(mealsOnDayQuery);
        const maxIndex = querySnapshot.docs.reduce((max, doc) => {
            const currentIdx = doc.data().sortIndex;
            return (currentIdx !== undefined && currentIdx > max) ? currentIdx : max;
        }, -1);
        const sortIndex = maxIndex + 1;
        
        let docToAdd = {
            name: mealData.name,
            quantity: mealData.quantity,
            type: mealData.type,
            date: Timestamp.fromDate(mealDate),
            sortIndex: sortIndex,
            recipeId: mealData.recipeId || null
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
        await addDoc(collection(db, `users/${userId}/meals`), docToAdd);
        showToast('Pasto aggiunto al diario!');
        resetAddMealForm();
    } catch (error) {
        console.error("Errore aggiunta pasto:", error);
        showToast("Si è verificato un errore.", true);
    } finally {
        addBtn.disabled = false;
        addBtn.innerHTML = originalBtnHTML;
    }
}

async function deleteMeal(mealId) {
    if (!isOnline) return showToast("Sei offline. Impossibile eliminare.", true);
    
    showConfirmationModal("Sei sicuro di voler eliminare questo pasto?", async () => {
        try {
            await deleteDoc(doc(db, `users/${userId}/meals`, mealId));
            showToast('Pasto eliminato con successo!');
        } catch (error) {
            console.error("Errore eliminazione pasto:", error);
            showToast("Errore durante l'eliminazione.", true);
        }
    });
}

async function saveMealChanges() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);
    if (!mealToEditId) return;

    const newQuantity = parseFloat(document.getElementById('edit-meal-quantity').value);
    const newName = document.getElementById('edit-meal-name-input').value.trim();
    const newType = document.getElementById('edit-meal-type').value;
    const mealRef = doc(db, `users/${userId}/meals`, mealToEditId);
    const mealToEdit = allMeals.find(m => m.id === mealToEditId);
    
    let dataToUpdate = {
        name: newName,
        type: newType,
        date: getMealTimestamp(newType, selectedDate)
    };

    if (mealToEdit.isCustom) {
        const calories = parseFloat(document.getElementById('edit-meal-calories').value);
        const proteins = parseFloat(document.getElementById('edit-meal-proteins').value);
        const carbs = parseFloat(document.getElementById('edit-meal-carbs').value);
        const fats = parseFloat(document.getElementById('edit-meal-fats').value);

        if (!newName || isNaN(calories) || isNaN(proteins) || isNaN(carbs) || isNaN(fats)) {
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
        await updateDoc(mealRef, dataToUpdate);
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

        // Genera i token per la ricerca
        const search_tokens = name.toLowerCase().split(/[\s,.;:()_/-]+/)
                                  .filter(token => token.length > 0); // Rimuove eventuali token vuoti

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
    const search_tokens = name.toLowerCase().split(/[\s,.;:()_/-]+/).filter(token => token.length > 0);

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
    if (!isOnline) return; // Non salva se offline

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
            const search_tokens = name.toLowerCase().split(/[\s,.;:()_/-]+/).filter(token => token.length > 0);
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

async function saveRecipe() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);

    const name = document.getElementById('recipe-name').value.trim();
    const servings = parseInt(document.getElementById('recipe-servings').value) || 1;
    if (!name) return showToast('Inserisci un nome per la ricetta.', true);
    if (servings <= 0) return showToast('Il numero di porzioni deve essere maggiore di zero.', true);
    
    const ingredients = Array.from(document.querySelectorAll('#recipe-ingredients > div'))
        .map(el => {
            const nameInput = el.querySelector('.recipe-ingredient-name');
            return {
                name: nameInput.value.trim(),
                quantity: parseFloat(el.querySelector('.recipe-ingredient-quantity').value),
                foodId: nameInput.dataset.foodId // Recupera l'ID salvato
            };
        })
        .filter(ing => ing.name && ing.quantity > 0);

    if (ingredients.length === 0) return showToast('Aggiungi almeno un ingrediente valido.', true);

    if (ingredients.length > 30) {
        return showToast('Una ricetta non può avere più di 30 ingredienti (limite del database).', true);
    }

    const saveBtn = document.getElementById('save-recipe-btn');
    const originalBtnHTML = saveBtn.innerHTML;

    try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Salvataggio...`;

        // 1. Recupera i dati di tutti gli ingredienti con una sola query
        const ingredientIds = ingredients.map(ing => ing.foodId).filter(id => id);
        const foodDataMap = new Map();
        if (ingredientIds.length > 0) {
            const q = query(collection(db, 'foods'), where(documentId(), 'in', ingredientIds));
            const snapshot = await getDocs(q);
            snapshot.forEach(doc => foodDataMap.set(doc.id, doc.data()));
        }

        // 2. Verifica se tutti gli ingredienti sono stati trovati nel database
        const missingIngredients = ingredients.filter(ing => !ing.foodId || !foodDataMap.has(ing.foodId));
        if (missingIngredients.length > 0) {
            const missingNames = missingIngredients.map(ing => ing.name).join(', ');
            throw new Error(`Ingredienti non validi: ${missingNames}. Selezionali dalla lista per confermarli.`);
        }

        // 3. Calcola i totali nutrizionali e il peso totale
        const { totalNutrition, totalWeight } = ingredients.reduce((acc, ing) => {
            const foodData = foodDataMap.get(ing.foodId);
            if (foodData) {
                const ratio = ing.quantity / 100;
                acc.totalNutrition.calories += (foodData.calories || 0) * ratio;
                acc.totalNutrition.proteins += (foodData.proteins || 0) * ratio;
                acc.totalNutrition.carbs += (foodData.carbs || 0) * ratio;
                acc.totalNutrition.fats += (foodData.fats || 0) * ratio;
                acc.totalNutrition.fibers += (foodData.fibers || 0) * ratio;
                acc.totalWeight += ing.quantity;
            }
            return acc;
        }, { 
            totalNutrition: { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 },
            totalWeight: 0 
        });

        await addDoc(collection(db, `users/${userId}/recipes`), { 
            name, 
            name_lowercase: name.toLowerCase(),
            // Salva solo nome e quantità, l'ID non serve più dopo il calcolo
            ingredients: ingredients.map(({ name, quantity, foodId }) => ({ name, quantity, foodId })), 
            servings,
            totalNutrition,
            totalWeight
        });

        showToast(`Ricetta "${name}" salvata!`);
        resetRecipeForm();
    } catch (error) {
        console.error("Errore salvataggio ricetta:", error);
        if (error.message.startsWith('Ingredienti non validi')) {
            showToast(error.message, true);
        } else {
            showToast("Si è verificato un errore.", true);
        }
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnHTML;
    }
}

async function saveRecipeChanges() {
    if (!isOnline || !recipeToEditId) return;

    const name = document.getElementById('recipe-name').value.trim();
    const servings = parseInt(document.getElementById('recipe-servings').value) || 1;
    if (!name) return showToast('Inserisci un nome per la ricetta.', true);
    if (servings <= 0) return showToast('Il numero di porzioni deve essere maggiore di zero.', true);

    const ingredients = Array.from(document.querySelectorAll('#recipe-ingredients > div'))
        .map(el => {
            const nameInput = el.querySelector('.recipe-ingredient-name');
            return {
                name: nameInput.value.trim(),
                quantity: parseFloat(el.querySelector('.recipe-ingredient-quantity').value),
                foodId: nameInput.dataset.foodId
            };
        })
        .filter(ing => ing.name && ing.quantity > 0);

    if (ingredients.length === 0) return showToast('Aggiungi almeno un ingrediente valido.', true);

    const saveBtn = document.getElementById('save-recipe-btn');
    const originalBtnHTML = saveBtn.innerHTML;

    try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Salvataggio...`;

        const ingredientIds = ingredients.map(ing => ing.foodId).filter(id => id);
        const foodDataMap = new Map();
        if (ingredientIds.length > 0) {
            const q = query(collection(db, 'foods'), where(documentId(), 'in', ingredientIds));
            const snapshot = await getDocs(q);
            snapshot.forEach(doc => foodDataMap.set(doc.id, doc.data()));
        }

        const missingIngredients = ingredients.filter(ing => !ing.foodId || !foodDataMap.has(ing.foodId));
        if (missingIngredients.length > 0) {
            const missingNames = missingIngredients.map(ing => ing.name).join(', ');
            throw new Error(`Ingredienti non validi: ${missingNames}. Selezionali dalla lista per confermarli.`);
        }

        const { totalNutrition, totalWeight } = ingredients.reduce((acc, ing) => {
            const foodData = foodDataMap.get(ing.foodId);
            if (foodData) {
                const ratio = ing.quantity / 100;
                acc.totalNutrition.calories += (foodData.calories || 0) * ratio;
                acc.totalNutrition.proteins += (foodData.proteins || 0) * ratio;
                acc.totalNutrition.carbs += (foodData.carbs || 0) * ratio;
                acc.totalNutrition.fats += (foodData.fats || 0) * ratio;
                acc.totalNutrition.fibers += (foodData.fibers || 0) * ratio;
                acc.totalWeight += ing.quantity;
            }
            return acc;
        }, { totalNutrition: { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 }, totalWeight: 0 });

        const recipeRef = doc(db, `users/${userId}/recipes`, recipeToEditId);
        await updateDoc(recipeRef, {
            name,
            name_lowercase: name.toLowerCase(),
            ingredients: ingredients.map(({ name, quantity, foodId }) => ({ name, quantity, foodId })),
            servings,
            totalNutrition,
            totalWeight
        });

        showToast(`Ricetta "${name}" aggiornata!`);
        exitRecipeEditMode();
    } catch (error) {
        console.error("Errore aggiornamento ricetta:", error);
        if (error.message.startsWith('Ingredienti non validi')) {
            showToast(error.message, true);
        } else {
            showToast("Si è verificato un errore durante l'aggiornamento.", true);
        }
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnHTML;
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

async function useRecipe(recipeId) {
    if (!isOnline) return showToast("Sei offline. Impossibile usare la ricetta.", true);
    
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe || !recipe.totalNutrition || !recipe.totalWeight) {
        return showToast("Errore: Dati della ricetta incompleti. Prova a salvarla di nuovo.", true);
    }

    const mealType = document.getElementById('meal-type').value;
    const mealDate = getMealTimestamp(mealType, selectedDate);

    const { totalNutrition, totalWeight, servings, name } = recipe;

    // Calcola i nutrienti per 100g della ricetta
    const nutritionPer100g = {
        calories: ((totalNutrition.calories || 0) / totalWeight) * 100,
        proteins: ((totalNutrition.proteins || 0) / totalWeight) * 100,
        carbs: ((totalNutrition.carbs || 0) / totalWeight) * 100,
        fats: ((totalNutrition.fats || 0) / totalWeight) * 100,
        fibers: ((totalNutrition.fibers || 0) / totalWeight) * 100,
    };

    // Calcola il peso di una singola porzione
    const servingWeight = totalWeight / servings;

    try {
        // Aggiunge un pasto con i dati per 100g della ricetta e la quantità pari al peso di una porzione
        await addDoc(collection(db, `users/${userId}/meals`), {
            name: `${name} (1 porzione)`,
            ...nutritionPer100g,
            quantity: servingWeight,
            type: mealType,
            date: Timestamp.fromDate(mealDate),
            recipeId: recipe.id 
        });
        showToast(`1 porzione di "${name}" aggiunta al diario!`);
    } catch (error) {
        console.error("Errore aggiunta ricetta come pasto:", error);
        showToast("Si è verificato un errore.", true);
    }
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

        const foodData = { name: product_name || 'Nome non disponibile' };

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


// --- FUNZIONI DI RENDERING E AGGIORNAMENTO UI ---

function updateAllUI() {
    updateDateDisplay();
    renderSelectedDayMeals();
    renderWeeklyHistory();
    updateCharts(dailyTotalsCache, selectedDate);
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
            <div class="meal-category" data-category-name="${categoryName}">
                <div class="meal-category-header">
                    <h3 class="text-lg font-semibold text-slate-200">${categoryName}</h3>
                    <div class="text-xs md:text-sm font-medium text-slate-400 category-totals truncate mt-1">
                        <!-- I totali verranno aggiornati qui -->
                    </div>
                </div>
                <div class="p-4 space-y-3 meal-list-container">
                    <!-- I pasti verranno renderizzati qui -->
                </div>
            </div>
        `).join('');
    }
    
    // Ora aggiorniamo ogni categoria individualmente senza distruggere la struttura.
    Object.entries(mealsByCategory).forEach(([categoryName, meals]) => {
        const categoryElement = mainContainer.querySelector(`.meal-category[data-category-name="${categoryName}"]`);
        if (!categoryElement) return; // Salta se l'elemento non esiste

        const listContainer = categoryElement.querySelector('.meal-list-container');
        const totalsContainer = categoryElement.querySelector('.category-totals');
        const categoryTotals = { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        let mealsHTML = '';
        
        if (meals.length > 0) {
            // L'ordinamento è già stato fatto durante la creazione della cache
            mealsHTML = meals.map(meal => {
                const calculated = {
                    calories: ((Number(meal.calories) || 0) * (Number(meal.quantity) || 0) / 100),
                    proteins: ((Number(meal.proteins) || 0) * (Number(meal.quantity) || 0) / 100),
                    carbs: ((Number(meal.carbs) || 0) * (Number(meal.quantity) || 0) / 100),
                    fats: ((Number(meal.fats) || 0) * (Number(meal.quantity) || 0) / 100),
                    fibers: ((Number(meal.fibers) || 0) * (Number(meal.quantity) || 0) / 100)
                };
                Object.keys(categoryTotals).forEach(key => categoryTotals[key] += calculated[key]);
                return `
                <div class="meal-item is-entering flex flex-col md:flex-row md:items-center p-4" data-id="${meal.id}">
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-slate-200 break-words">${meal.name} (${Number(meal.quantity) || 0}g)</p>
                        <p class="text-xs md:text-sm text-slate-400 mt-1 meal-nutrition-details">
                            Cal:${calculated.calories.toFixed(0)} P:${calculated.proteins.toFixed(1)}g C:${calculated.carbs.toFixed(1)}g G:${calculated.fats.toFixed(1)}g F:${calculated.fibers.toFixed(1)}g
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
            mealsHTML = `<div class="text-center text-slate-500 italic py-4">Nessun pasto registrato</div>`;
        }
        
        // Aggiorna solo il contenuto della lista e dei totali, preservando la struttura.
        listContainer.innerHTML = mealsHTML;
        totalsContainer.innerHTML = `Cal:${categoryTotals.calories.toFixed(0)} P:${categoryTotals.proteins.toFixed(1)}g C:${categoryTotals.carbs.toFixed(1)}g G:${categoryTotals.fats.toFixed(1)}g F:${categoryTotals.fibers.toFixed(1)}g`;

        // Applica l'animazione di entrata ai nuovi elementi
        const newItems = listContainer.querySelectorAll('.meal-item.is-entering');
        if (newItems.length > 0) {
            requestAnimationFrame(() => {
                newItems.forEach(item => {
                    void item.offsetHeight; // Forza il reflow
                    item.classList.remove('is-entering');
                });
            });
        }
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
                        <div class="transition-all duration-500" style="background: linear-gradient(90deg, #10b981, #059669); width: ${proteinPerc.toFixed(2)}%;" title="Proteine: ${proteinPerc.toFixed(0)}%"></div>
                        <div class="transition-all duration-500" style="background: linear-gradient(90deg, #f59e0b, #d97706); width: ${carbPerc.toFixed(2)}%;" title="Carboidrati: ${carbPerc.toFixed(0)}%"></div>
                        <div class="transition-all duration-500" style="background: linear-gradient(90deg, #ef4444, #dc2626); width: ${fatPerc.toFixed(2)}%;" title="Grassi: ${fatPerc.toFixed(0)}%"></div>
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
                    <h4 class="font-bold text-lg text-slate-200 mb-3">${recipe.name} ${recipe.servings > 1 ? `(${recipe.servings} porzioni)` : ''}</h4>
                    <ul class="mt-2 text-sm text-slate-400 list-disc pl-5 space-y-1">
                        ${recipe.ingredients.map(ing => `<li>${ing.name}: ${ing.quantity}g</li>`).join('')}
                    </ul>
                    ${(recipe.totalNutrition && recipe.totalWeight && recipe.servings) ? `
                    <div class="mt-4 pt-4 border-t border-slate-700">
                        <p class="font-semibold text-slate-300 mb-2">Per porzione (~${(recipe.totalWeight / recipe.servings).toFixed(0)}g):</p>
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
    const today = getTodayUTC(); // Fissa "oggi" (UTC) all'inizio per coerenza
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today); // Crea una copia di "oggi"
        date.setUTCDate(today.getUTCDate() - i); // Sottrai i giorni dalla data fissata
        const dateKey = date.toISOString().split('T')[0];
        const totals = dailyTotalsCache[dateKey] || { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        const isToday = i === 0; // Modo più semplice e affidabile per verificare se è oggi
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
        document.getElementById(id).textContent = numericValue.toFixed(decimals);
        triggerFlashAnimation(id);
    };

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

    container.innerHTML = '';
    for (let i = 1; i <= nutritionGoals.water; i++) {
        const isFilled = i <= waterCount;
        container.innerHTML += `<i class="fas fa-glass-water water-glass ${isFilled ? 'filled' : ''}" aria-hidden="true"></i>`;
    }
    
    text.textContent = `${waterCount} / ${nutritionGoals.water} bicchieri`;

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
    const container = document.getElementById('day-meals-container');
    container.classList.add('is-updating');

    // Attendi che l'animazione di fade-out sia visibile
    await new Promise(resolve => setTimeout(resolve, 150));

    // Prima aggiorna tutta l'UI con la nuova data
    updateAllUI();
    // Poi imposta il listener per i dati dell'acqua sulla data corretta
    listenToWaterData();

    // Rimuovi la classe per far apparire il nuovo contenuto con un fade-in
    container.classList.remove('is-updating');
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
    const [year, month, day] = e.target.value.split('-').map(Number);
    // BUG FIX: Usa Date.UTC per creare la data. Questo previene problemi di fuso orario
    // dove il browser potrebbe interpretare la data come il giorno precedente.
    // new Date("2024-05-25") può diventare 24 Maggio 22:00 UTC in alcuni fusi orari.
    selectedDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    handleDayChange();
}

function resetAppData() {
    allMeals = [];
    recipes = [];
    dailyMealsCache = {}; // Pulisce la cache al logout
    destroyCharts();
    document.getElementById('selected-day-meals').innerHTML = '';
    if (waterHistoryUnsubscribe) { waterHistoryUnsubscribe(); waterHistoryUnsubscribe = null; }
    if (waterUnsubscribe) { waterUnsubscribe(); waterUnsubscribe = null; }
    document.getElementById('saved-recipes').innerHTML = '';
    document.getElementById('weekly-history').innerHTML = '';
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

    // Mappa per definire nomi, unità, icone e gruppi
    const nutrientMap = {
        // Macronutrienti
        calories: { name: 'Calorie', unit: 'kcal', icon: 'fa-fire-alt text-red-500', group: 'macro' },
        proteins: { name: 'Proteine', unit: 'g', icon: 'fa-drumstick-bite text-green-500', group: 'macro' },
        carbs: { name: 'Carboidrati', unit: 'g', icon: 'fa-bread-slice text-yellow-500', group: 'macro' },
        fats: { name: 'Grassi', unit: 'g', icon: 'fa-bacon text-pink-500', group: 'macro' },
        fibers: { name: 'Fibre', unit: 'g', icon: 'fa-seedling text-blue-500', group: 'macro' },
        amido_g: { name: 'Amido', unit: 'g', icon: 'fa-bread-slice text-yellow-500', group: 'macro' },
        zuccheri_solubili_g: { name: 'Zuccheri', unit: 'g', icon: 'fa-bread-slice text-yellow-500', group: 'macro' },
        acqua_g: { name: 'Acqua', unit: 'g', icon: 'fa-tint text-cyan-400', group: 'macro' },
        colesterolo_mg: { name: 'Colesterolo', unit: 'mg', icon: 'fa-bacon text-pink-500', group: 'macro' },
        
        // Minerali
        calcio_mg: { name: 'Calcio', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        sodio_mg: { name: 'Sodio', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        potassio_mg: { name: 'Potassio', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        ferro_mg: { name: 'Ferro', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        fosforo_mg: { name: 'Fosforo', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        zinco_mg: { name: 'Zinco', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        magnesio_mg: { name: 'Magnesio', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        rame_mg: { name: 'Rame', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        selenio_mcg: { name: 'Selenio', unit: 'µg', icon: 'fa-atom text-gray-400', group: 'mineral' },
        manganese_mg: { name: 'Manganese', unit: 'mg', icon: 'fa-atom text-gray-400', group: 'mineral' },

        // Vitamine
        vitamina_c_mg: { name: 'Vitamina C', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        tiamina_mg: { name: 'Vitamina B1', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        riboflavina_mg: { name: 'Vitamina B2', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        niacina_mg: { name: 'Vitamina B3', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        vitamina_b6_mg: { name: 'Vitamina B6', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        vitamina_b12_mcg: { name: 'Vitamina B12', unit: 'µg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        folati_mcg: { name: 'Folati (B9)', unit: 'µg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        vitamina_a_retinolo_equivalente_mcg: { name: 'Vitamina A', unit: 'µg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        vitamina_d_mcg: { name: 'Vitamina D', unit: 'µg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
        vitamina_e_mg: { name: 'Vitamina E', unit: 'mg', icon: 'fa-capsules text-orange-400', group: 'vitamin' },
    };

    const groups = {
        macro: { title: 'Macronutrienti Principali', items: [], order: 1 },
        mineral: { title: 'Minerali', items: [], order: 2 },
        vitamin: { title: 'Vitamine', items: [], order: 3 },
        other: { title: 'Altri Nutrienti', items: [], order: 4 }
    };

    const excludedFields = new Set(['name', 'name_lowercase', 'original_id', 'source_url', 'energia_kj']);

    for (const key in food) {
        if (food.hasOwnProperty(key) && !excludedFields.has(key) && typeof food[key] === 'number' && food[key] > 0) {
            const info = nutrientMap[key];
            const groupKey = info ? info.group : 'other';
            
            if (groups[groupKey]) {
                groups[groupKey].items.push({
                    key: key,
                    value: food[key],
                    ...info
                });
            }
        }
    }

    // Ordina i macronutrienti principali
    const macroOrder = ['calories', 'proteins', 'carbs', 'fats', 'fibers'];
    groups.macro.items.sort((a, b) => {
        const indexA = macroOrder.indexOf(a.key);
        const indexB = macroOrder.indexOf(b.key);
        if (indexA === -1 && indexB === -1) return a.name.localeCompare(b.name);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });

    let htmlContent = '';
    Object.values(groups).sort((a, b) => a.order - b.order).forEach(group => {
        if (group.items.length > 0) {
            htmlContent += `<li class="nutrient-group-header col-span-full">${group.title}</li>`;
            group.items.forEach(item => {
                const displayName = item.name || item.key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                const unit = item.unit ? ` ${item.unit}` : '';
                const icon = item.icon || 'fa-atom text-gray-400';
                
                htmlContent += `
                    <li>
                        <i class="fas ${icon} w-5 text-center mr-2" aria-hidden="true"></i>
                        <strong>${displayName}:</strong> 
                        <span>${item.value}${unit}</span>
                    </li>`;
            });
        }
    });

    if (htmlContent === '') {
        detailsList.innerHTML = `<li class="col-span-full text-slate-400">Nessun dato nutrizionale dettagliato disponibile per questo alimento.</li>`;
    } else {
        detailsList.innerHTML = htmlContent;
    }
    detailsContainer.classList.remove('hidden');
}

async function setWaterCount(newCount) {
    const finalCount = Math.max(0, newCount);
    if (isNaN(finalCount)) return;

    // Aggiornamento ottimistico: aggiorna subito l'UI
    waterCount = finalCount;
    renderWaterTracker();

    // Poi salva su Firestore in background
    if (!userId || !isOnline) {
        if (!isOnline) showToast("Sei offline. Il conteggio non verrà salvato.", true);
        return;
    }
    const dateString = selectedDate.toISOString().split('T')[0];
    const waterDocRef = doc(db, `users/${userId}/water`, dateString);

    try {
        await setDoc(waterDocRef, { count: finalCount }, { merge: true });
    } catch (error) {
        console.error("Errore salvataggio acqua (setWaterCount):", error);
        showToast("Errore nel salvare il conteggio dell'acqua.", true);
        // Se il salvataggio fallisce, potremmo voler ripristinare il valore precedente,
        // ma per ora il listener onSnapshot dovrebbe gestire la coerenza.
    }
}

async function incrementWaterCount(amount) {
    const newCount = waterCount + amount;
    const finalCount = Math.max(0, newCount);

    // Aggiornamento ottimistico: aggiorna subito l'UI
    waterCount = finalCount;
    renderWaterTracker();

    // Poi salva su Firestore in background
    if (!userId || !isOnline) {
        if (!isOnline) showToast("Sei offline. Il conteggio non verrà salvato.", true);
        return;
    }

    const dateString = selectedDate.toISOString().split('T')[0];
    const waterDocRef = doc(db, `users/${userId}/water`, dateString);
    setDoc(waterDocRef, { count: finalCount }, { merge: true }).catch(e => {
        console.error("Salvataggio acqua fallito: ", e);
        showToast("Errore nell'aggiornare il conteggio dell'acqua.", true);
    });
}

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
    const waterDocRef = doc(db, `users/${userId}/water`, dateString);

    waterUnsubscribe = onSnapshot(waterDocRef, (doc) => {
        const data = doc.data();
        const newCount = data?.count || 0;
        waterCount = newCount; // Aggiorna il valore globale
        renderWaterTracker();
    }, (error) => {
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

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateString = thirtyDaysAgo.toISOString().split('T')[0];

    const waterQuery = query(
        collection(db, `users/${userId}/water`),
        where(documentId(), '>=', dateString)
    );

    waterHistoryUnsubscribe = onSnapshot(waterQuery, (snapshot) => {
        const newHistory = {};
        snapshot.forEach(doc => {
            newHistory[doc.id] = doc.data().count;
        });
        waterHistory = newHistory;
        renderWeeklyHistory(); // Re-render the history table when data arrives/changes
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

    const standardFields = document.getElementById('edit-standard-meal-fields');
    const customFields = document.getElementById('edit-custom-meal-fields');

    document.getElementById('edit-meal-name-input').value = meal.name;
    document.getElementById('edit-meal-type').value = meal.type;

    if (meal.isCustom) {
        standardFields.classList.add('hidden');
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

function setupIngredientSearch(ingredientInput) {
    const resultsContainer = ingredientInput.parentElement.querySelector('.recipe-ingredient-results');

    setupSearchHandler({
        inputElement: ingredientInput,
        resultsContainer: resultsContainer,
        searchFunction: searchFoodsOnly,
        onResultClick: (item) => {
            ingredientInput.value = item.name;
            ingredientInput.dataset.foodId = item.id;
            // Store nutritional data for recipe calculation
            ingredientInput.dataset.calories = item.calories || 0;
            ingredientInput.dataset.proteins = item.proteins || 0;
            ingredientInput.dataset.carbs = item.carbs || 0;
            ingredientInput.dataset.fats = item.fats || 0;
            ingredientInput.dataset.fibers = item.fibers || 0;
            updateRecipeBuilderMacroBar();
        },
        itemRenderer: (item) => `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer flex items-center" data-item-id="${item.id}">
                <i class="fas fa-utensils text-indigo-400 mr-3"></i>
                <div>
                    <div class="font-medium text-slate-200">${item.name}</div>
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
        if (!dailyTotalsCache[dateKey]) {
            dailyTotalsCache[dateKey] = { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        }
        const ratio = (Number(meal.quantity) || 0) / 100;
        const totals = dailyTotalsCache[dateKey]; 
        // FIX: Rende il calcolo più robusto, usando i nuovi campi come fallback
        // per garantire che i totali non diventino NaN (Not a Number).
        const mealCalories = meal.calories ?? meal.energia_kcal ?? 0; // Corretto
        const mealProteins = meal.proteins ?? meal.proteine_g ?? 0;
        const mealCarbs = meal.carbs ?? meal.carboidrati_disponibili_g ?? 0;
        const mealFats = meal.fats ?? meal.lipidi_g ?? 0;
        const mealFibers = meal.fibers ?? meal.fibra_totale_g ?? 0;

        // FIX: Aggiunto controllo isNaN per ogni valore prima di sommarlo.
        // Questo previene la propagazione di NaN (Not a Number) nei totali.
        const cal = (Number(mealCalories) || 0) * ratio;
        const pro = (Number(mealProteins) || 0) * ratio;
        const car = (Number(mealCarbs) || 0) * ratio;
        const fat = (Number(mealFats) || 0) * ratio;
        const fib = (Number(mealFibers) || 0) * ratio;

        if (!isNaN(cal)) totals.calories += cal;
        if (!isNaN(pro)) totals.proteins += pro;
        if (!isNaN(car)) totals.carbs += car;
        if (!isNaN(fat)) totals.fats += fat;
        if (!isNaN(fib)) totals.fibers += fib;
    });
}


function resetAddMealForm() {
    document.getElementById('food-search').value = '';
    const quantityInput = document.getElementById('meal-quantity');
    quantityInput.value = '';
    quantityInput.disabled = false;
    selectedFood = null;
    document.getElementById('search-results').style.display = 'none';
    updateMealPreview(); // Nasconde l'anteprima
    document.getElementById('food-search').focus();

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
}

function resetNewFoodForm() {
    ['new-food-name', 'new-food-calories', 'new-food-proteins', 'new-food-carbs', 'new-food-fats', 'new-food-fibers']
        .forEach(id => document.getElementById(id).value = '');
    document.getElementById('new-food-name').focus();
}

function openEditFoodModal() {
    const foodId = document.getElementById('edit-lookup-food-btn').dataset.foodId;
    const food = foods.find(f => f.id === foodId); // Cerca l'alimento nel database globale
    if (!food) {
        return showToast("Alimento non trovato.", true);
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

    const ingredientsContainer = document.getElementById('recipe-ingredients');
    ingredientsContainer.innerHTML = ''; // Pulisci gli ingredienti esistenti

    recipe.ingredients.forEach(ing => {
        const newRow = document.createElement('div');
        newRow.className = 'ingredient-row flex gap-3 items-start';
        newRow.innerHTML = `
            <div class="flex-1 relative">
                <input type="text" class="recipe-ingredient-name input-modern w-full" placeholder="Cerca ingrediente..." autocomplete="off" value="${ing.name}" data-food-id="${ing.foodId || ''}">
                <div class="recipe-ingredient-results search-results mt-2 max-h-48 overflow-y-auto absolute w-full z-10 hidden"></div>
            </div>
            <input type="number" class="recipe-ingredient-quantity input-modern w-24" placeholder="g" value="${ing.quantity}">
            <button type="button" class="btn-modern btn-danger !py-2 !px-3 remove-ingredient-btn"><i class="fas fa-trash"></i></button>
        `;
        ingredientsContainer.appendChild(newRow);

        // Set up search functionality for this ingredient input
        const ingredientInput = newRow.querySelector('.recipe-ingredient-name');
        setupIngredientSearch(ingredientInput);
    });

    // Cambia l'UI per la modalità di modifica
    document.querySelector('#recipes-content h3').textContent = 'Modifica Ricetta';
    const saveBtn = document.getElementById('save-recipe-btn');
    saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i> Salva Modifiche';
    saveBtn.onclick = saveRecipeChanges; // Cambia l'azione del pulsante

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
    saveBtn.onclick = saveRecipe;

    const cancelButton = document.getElementById('cancel-edit-recipe-btn');
    if (cancelButton) cancelButton.remove();

    resetRecipeForm();
}

// --- Funzioni di ricerca ---

// Funzione di utilità per calcolare lo score di pertinenza di un risultato di ricerca
const calculateSearchScore = (item, searchTerm) => {
    const nameLower = item.name_lowercase || '';
    if (nameLower === searchTerm) return 100; // Corrispondenza esatta
    if (nameLower.startsWith(searchTerm)) return 90; // Corrispondenza prefisso
    
    const searchTokens = searchTerm.split(' ').filter(t => t.length > 0);
    if (searchTokens.some(st => (item.search_tokens || []).includes(st))) return 80; // Corrispondenza token

    if (nameLower.includes(searchTerm)) return 70; // Contiene la stringa
    return 0; // Nessuna corrispondenza forte
};

// Ordina i risultati in base allo score e poi alfabeticamente
const sortResults = (results, searchTerm) => results.sort((a, b) => calculateSearchScore(b, searchTerm) - calculateSearchScore(a, searchTerm) || a.name.localeCompare(b.name));

function setupSearchHandler({ inputElement, resultsContainer, searchFunction, onResultClick, itemRenderer }) {
    let currentResults = [];
    let dynamicDropdown = null;

    const debouncedSearch = debounce(async (searchTerm) => {
        if (searchTerm.length >= 2) {
            currentResults = await searchFunction(searchTerm);
            const renderedHTML = currentResults.length > 0 ? currentResults.map(itemRenderer).join('') : `<div class="p-4 text-slate-500">Nessun risultato.</div>`;

            // Remove existing dropdown
            if (dynamicDropdown) {
                dynamicDropdown.remove();
            }

            // Create new dropdown directly in body
            dynamicDropdown = document.createElement('div');
            dynamicDropdown.innerHTML = renderedHTML;
            dynamicDropdown.id = 'dynamic-search-results';

            // Apply styles with maximum priority
            const inputRect = inputElement.getBoundingClientRect();
            const styles = {
                'position': 'fixed',
                'top': (inputRect.bottom + 8) + 'px',
                'left': inputRect.left + 'px',
                'width': inputRect.width + 'px',
                'max-height': '300px',
                'min-height': '50px',
                'background-color': 'rgba(15, 23, 42, 0.95)',
                'border': '1px solid rgba(148, 163, 184, 0.1)',
                'border-radius': '16px',
                'z-index': '2147483647',
                'display': 'block',
                'visibility': 'visible',
                'opacity': '1',
                'overflow-y': 'auto',
                'box-shadow': '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                'backdrop-filter': 'blur(20px)',
                '-webkit-backdrop-filter': 'blur(20px)',
                'pointer-events': 'auto'
            };

            // Apply all styles
            Object.entries(styles).forEach(([prop, value]) => {
                dynamicDropdown.style.setProperty(prop, value, 'important');
            });

            // Append to body (bypasses any container issues)
            document.body.appendChild(dynamicDropdown);

            // Update position on scroll to keep dropdown attached to input
            const updatePosition = () => {
                if (dynamicDropdown && document.body.contains(dynamicDropdown)) {
                    const rect = inputElement.getBoundingClientRect();
                    dynamicDropdown.style.setProperty('top', (rect.bottom + 8) + 'px', 'important');
                    dynamicDropdown.style.setProperty('left', rect.left + 'px', 'important');
                    dynamicDropdown.style.setProperty('width', rect.width + 'px', 'important');
                }
            };

            // Add scroll listener to update position
            window.addEventListener('scroll', updatePosition, { passive: true });
            window.addEventListener('resize', updatePosition, { passive: true });

            // Store the cleanup function
            dynamicDropdown._cleanup = () => {
                window.removeEventListener('scroll', updatePosition);
                window.removeEventListener('resize', updatePosition);
            };

            // Add click handler to dynamic dropdown
            dynamicDropdown.addEventListener('click', (e) => {
                const itemElement = e.target.closest('.search-item');
                if (itemElement) {
                    const itemId = itemElement.dataset.itemId;
                    const selectedItem = currentResults.find(item => item.id === itemId);
                    if (selectedItem) {
                        onResultClick(selectedItem);
                        if (dynamicDropdown._cleanup) dynamicDropdown._cleanup();
                        dynamicDropdown.remove();
                        dynamicDropdown = null;
                        inputElement.blur();
                    }
                }
            });
        } else {
            // Hide dropdown when search term is too short
            if (dynamicDropdown) {
                if (dynamicDropdown._cleanup) dynamicDropdown._cleanup();
                dynamicDropdown.remove();
                dynamicDropdown = null;
            }
            currentResults = [];
        }
    }, 300);

    inputElement.addEventListener('input', (e) => {
        debouncedSearch(e.target.value.toLowerCase());
    });

    // Clean up on click outside
    document.addEventListener('click', (e) => {
        if (dynamicDropdown && !dynamicDropdown.contains(e.target) && !inputElement.contains(e.target)) {
            if (dynamicDropdown._cleanup) dynamicDropdown._cleanup();
            dynamicDropdown.remove();
            dynamicDropdown = null;
        }
    });
}

async function searchFoodsOnly(searchTerm) {
    const lowerCaseSearchTerm = searchTerm.toLowerCase();

    // Query 1: Prefix search on the whole name
    const prefixQuery = query(
        collection(db, 'foods'),
        where('name_lowercase', '>=', lowerCaseSearchTerm),
        where('name_lowercase', '<=', lowerCaseSearchTerm + '\uf8ff'),
        limit(10)
    );

    // Query 2: Token search for words inside the name
    const tokenQuery = query(
        collection(db, 'foods'),
        where('search_tokens', 'array-contains', lowerCaseSearchTerm),
        limit(10)
    );

    try {
        // Esegui le query su Firestore
        const [prefixSnapshot, tokenSnapshot] = await Promise.allSettled([
            getDocs(prefixQuery),
            getDocs(tokenQuery)
        ]);

        const results = new Map();

        // Aggiungi i risultati da Firestore
        if (prefixSnapshot.status === 'fulfilled') {
            prefixSnapshot.value.docs.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: false }));
        }
        if (tokenSnapshot.status === 'fulfilled') {
            tokenSnapshot.value.docs.forEach(doc => {
                if (!results.has(doc.id)) {
                    results.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: false });
                }
            });
        }

        // Aggiungi ricerca client-side per sottostringhe e token
        const searchTokens = lowerCaseSearchTerm.split(' ').filter(t => t.length > 0);
        foods.forEach(food => {
            if (!results.has(food.id)) {
                const nameLower = food.name_lowercase || '';
                const foodTokens = food.search_tokens || [];
                // Cerca se il nome include il termine o se qualche token di ricerca matcha
                if (nameLower.includes(lowerCaseSearchTerm) || searchTokens.some(st => foodTokens.includes(st))) {
                    results.set(food.id, { ...food, isRecipe: false });
                }
            }
        });

        const finalResults = Array.from(results.values());
        // Ordina i risultati in base alla pertinenza
        sortResults(finalResults, lowerCaseSearchTerm);

        return finalResults.slice(0, 20); // Limita i risultati finali
    } catch (error) {
        console.error("Errore in searchFoodsOnly:", error);
        showToast("Errore durante la ricerca nel database.", true);
        return [];
    }
}

async function searchFoodsAndRecipes(searchTerm) {
    if (searchTerm.length < 2) return [];
    const lowerCaseSearchTerm = searchTerm.toLowerCase();

    try {
        // Query 1: Prefix search on the whole name
        const prefixQuery = query(
            collection(db, 'foods'),
            where('name_lowercase', '>=', lowerCaseSearchTerm),
            where('name_lowercase', '<=', lowerCaseSearchTerm + '\uf8ff'),
            limit(10)
        );

        // Query 2: Token search for words inside the name
        const tokenQuery = query(
            collection(db, 'foods'),
            where('search_tokens', 'array-contains', lowerCaseSearchTerm),
            limit(10)
        );
        
        // Promise per la ricerca di ricette (prefix search)
        const recipesQuery = query(
            collection(db, `users/${userId}/recipes`),
            where('name_lowercase', '>=', lowerCaseSearchTerm),
            where('name_lowercase', '<=', lowerCaseSearchTerm + '\uf8ff'),
            orderBy('name_lowercase'),
            limit(10)
        );

        // Esegui le query in parallelo, gestendo eventuali fallimenti
        const [prefixSnapshot, tokenSnapshot, recipesSnapshot] = await Promise.allSettled([
            getDocs(prefixQuery),
            getDocs(tokenQuery),
            getDocs(recipesQuery)
        ]);

        const results = new Map();

        // Aggiungi ricette
        if (recipesSnapshot.status === 'fulfilled') {
            recipesSnapshot.value.docs.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: true }));
        }

        // Aggiungi alimenti da Firestore
        if (prefixSnapshot.status === 'fulfilled') {
            prefixSnapshot.value.docs.forEach(doc => results.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: false }));
        }
        if (tokenSnapshot.status === 'fulfilled') {
            tokenSnapshot.value.docs.forEach(doc => {
                if (!results.has(doc.id)) results.set(doc.id, { id: doc.id, ...doc.data(), isRecipe: false });
            });
        }

        // Aggiungi ricerca client-side per sottostringhe e token su alimenti e ricette
        const searchTokens = lowerCaseSearchTerm.split(' ').filter(t => t.length > 0);
        [...foods, ...recipes].forEach(item => {
            if (!results.has(item.id)) {
                const nameLower = item.name_lowercase || '';
                const itemTokens = item.search_tokens || []; // Le ricette non hanno search_tokens, ma è sicuro
                if (nameLower.includes(lowerCaseSearchTerm) || searchTokens.some(st => itemTokens.includes(st))) {
                    results.set(item.id, { ...item, isRecipe: !!item.ingredients });
                }
            }
        });

        // Combina e ordina i risultati
        const combinedResults = Array.from(results.values());
        sortResults(combinedResults, lowerCaseSearchTerm);

        return combinedResults.slice(0, 20);
    } catch (error) {
        console.error("Errore nella ricerca unificata:", error);
        showToast("Errore durante la ricerca.", true);
        return [];
    }
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
    const quantity = parseFloat(document.getElementById('meal-quantity').value);

    if (!selectedFood || isNaN(quantity) || quantity <= 0) {
        previewContainer.classList.add('hidden');
        return;
    }

    previewContainer.classList.remove('hidden');

    const ratio = quantity / 100;
    let foodData = selectedFood;

    // Se è una ricetta, ricalcola i valori per 100g prima di procedere
    if (selectedFood.isRecipe) {
        const { totalNutrition, totalWeight } = selectedFood;
        foodData = {
            calories: ((totalNutrition.calories || 0) / totalWeight) * 100,
            proteins: ((totalNutrition.proteins || 0) / totalWeight) * 100,
            carbs: ((totalNutrition.carbs || 0) / totalWeight) * 100,
            fats: ((totalNutrition.fats || 0) / totalWeight) * 100,
            fibers: ((totalNutrition.fibers || 0) / totalWeight) * 100,
        };
    }

    document.getElementById('preview-calories').textContent = ((foodData.calories || 0) * ratio).toFixed(0);
    document.getElementById('preview-proteins').textContent = `${((foodData.proteins || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-carbs').textContent = `${((foodData.carbs || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-fats').textContent = `${((foodData.fats || 0) * ratio).toFixed(1)} g`;
    document.getElementById('preview-fibers').textContent = `${((foodData.fibers || 0) * ratio).toFixed(1)} g`;
}

// --- Funzioni Scanner ---

async function startScanner(onDecode) {
    onDecodeCallback = onDecode;
    const scannerModal = document.getElementById('scanner-modal');
    const feedbackEl = document.getElementById('scanner-feedback');
    const cameraSelect = document.getElementById('camera-select');
    scannerModal.classList.remove('hidden');
    scannerModal.classList.add('flex');
    feedbackEl.textContent = 'Avvio fotocamera...';

    try {
        // Ottieni la lista delle fotocamere solo se non è già stata caricata.
        // Questo preserva la selezione dell'utente nelle aperture successive.
        if (availableCameras.length === 0) {
            availableCameras = await window.Html5Qrcode.getCameras();
            if (!availableCameras || availableCameras.length === 0) {
                throw new Error("Nessuna fotocamera trovata.");
            }
            // Imposta la seconda fotocamera (indice 4) come predefinita, se esiste.
            currentCameraIndex = availableCameras.length > 3 ? 3 : 0;
        }

        // Popola il dropdown delle fotocamere
        cameraSelect.innerHTML = '';
        availableCameras.forEach((camera, index) => {
            const option = document.createElement('option');
            option.value = camera.id;
            option.textContent = camera.label || `Fotocamera ${index + 1}`;
            cameraSelect.appendChild(option);
        });
        cameraSelect.selectedIndex = currentCameraIndex;

        // Crea l'istanza dello scanner se non esiste
        if (!html5QrCode) {
            html5QrCode = new window.Html5Qrcode("scanner-reader", {
                formatsToSupport: [
                    window.Html5QrcodeSupportedFormats.EAN_13,
                    window.Html5QrcodeSupportedFormats.EAN_8,
                    window.Html5QrcodeSupportedFormats.UPC_A,
                    window.Html5QrcodeSupportedFormats.UPC_E
                ]
            });
        }

        // Avvia la scansione con la fotocamera selezionata
        await startScanningWithCurrentCamera();

    } catch (err) {
        console.error("Errore critico avvio scanner:", err);
        feedbackEl.textContent = "Errore fotocamera. Controlla i permessi.";
        showToast("Impossibile avviare la fotocamera. Controlla i permessi del browser.", true);
    }
}

async function startScanningWithCurrentCamera() {
    if (!html5QrCode || availableCameras.length === 0) return;

    const feedbackEl = document.getElementById('scanner-feedback');
    feedbackEl.textContent = 'Inquadra un codice a barre...';

    // Ferma la scansione precedente se attiva
    if (html5QrCode.isScanning) {
        await html5QrCode.stop();
    }

    const config = {
        fps: 10,
        qrbox: { width: 250, height: 150 }
    };

    const onScanSuccess = async (decodedText, decodedResult) => {
        // Chiama la funzione centralizzata per il feedback
        await triggerSuccessFeedback();
        await stopScanner();
        showToast(`Codice trovato!`);
        if (onDecodeCallback) {
            onDecodeCallback(decodedText);
        }
        onDecodeCallback = null;
    };

    const onScanFailure = (error) => { /* Ignora errori di non trovato */ };

    try {
        await html5QrCode.start(
            availableCameras[currentCameraIndex].id,
            config,
            onScanSuccess,
            onScanFailure
        );
    } catch (err) {
        console.error(`Errore avvio fotocamera ${availableCameras[currentCameraIndex].id}:`, err);
        feedbackEl.textContent = "Errore avvio fotocamera.";
        showToast("Impossibile avviare questa fotocamera.", true);
    }
}

async function toggleFlash() {
    if (!html5QrCode || !html5QrCode.isScanning) {
        return showToast("Lo scanner non è attivo.", true);
    }

    try {
        const capabilities = html5QrCode.getRunningTrackCapabilities();
        const settings = html5QrCode.getRunningTrackSettings();

        if (!capabilities.torch) {
            return showToast("Il tuo dispositivo non supporta il controllo del flash.", true);
        }

        const newFlashState = !settings.torch;
        await html5QrCode.applyVideoConstraints({
            advanced: [{ torch: newFlashState }]
        });

        showToast(`Flash ${newFlashState ? 'attivato' : 'disattivato'}.`);
        document.getElementById('toggle-flash-btn').classList.toggle('btn-primary', newFlashState);
        document.getElementById('toggle-flash-btn').classList.toggle('bg-slate-600', !newFlashState);
    } catch (err) {
        console.error("Errore nel controllare il flash:", err);
        showToast("Impossibile controllare il flash.", true);
    }
}

async function handleCameraChange(event) {
    // Aggiorna l'indice della fotocamera in base alla selezione dell'utente
    currentCameraIndex = event.target.selectedIndex;
    if (currentCameraIndex !== -1) {
        await startScanningWithCurrentCamera();
        showToast(`Fotocamera cambiata: ${availableCameras[currentCameraIndex].label || `Fotocamera ${currentCameraIndex + 1}`}`);
    }
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    showToast('Elaborazione immagine...');

    if (!html5QrCode) {
        html5QrCode = new window.Html5Qrcode("scanner-reader");
    }

    try {
        const decodedText = await html5QrCode.scanFile(file, false);
        // Chiama la funzione centralizzata per il feedback
        await triggerSuccessFeedback();
        await stopScanner();
        showToast(`Codice trovato!`);
        if (onDecodeCallback) {
            onDecodeCallback(decodedText);
        }
    } catch (err) {
        console.error("Errore scansione file:", err);
        showToast("Nessun codice a barre trovato nell'immagine.", true);
    } finally {
        onDecodeCallback = null;
        event.target.value = ''; // Permette di ricaricare lo stesso file
    }
}

/**
 * Gestisce il feedback di successo (vibrazione e animazione) in modo centralizzato.
 */
async function triggerSuccessFeedback() {
    // Esegue l'animazione visiva
    await playScanSuccessAnimation('scanner-reader');
}

/**
 * Applica un'animazione a un elemento e restituisce una Promise che si risolve
 * quando l'animazione è terminata.
 * @param {string} elementId L'ID dell'elemento da animare.
 * @returns {Promise<void>}
 */
function playScanSuccessAnimation(elementId) {
    return new Promise(resolve => {
        const element = document.getElementById(elementId);
        if (!element) return resolve();

        const onAnimationEnd = () => {
            element.classList.remove('flash-scan-success');
            resolve();
        };
        element.addEventListener('animationend', onAnimationEnd, { once: true });
        element.classList.add('flash-scan-success');
    });
}

async function stopScanner() {
    const scannerModal = document.getElementById('scanner-modal');
    scannerModal.classList.add('hidden');
    scannerModal.classList.remove('flex');

    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
            // Resetta lo stato del pulsante del flash quando lo scanner si ferma
            const flashBtn = document.getElementById('toggle-flash-btn');
            flashBtn.classList.remove('btn-primary');
            flashBtn.classList.add('bg-slate-600');
        } catch (error) {
            console.error("Fallimento nel fermare lo scanner.", error);
        }
    }
}

function populateMealForm(foodData) {
    document.getElementById('food-search').value = foodData.name;
    document.getElementById('meal-quantity').value = 100;
    selectedFood = foodData;
    showToast(`Prodotto trovato: ${foodData.name}`);
    document.getElementById('meal-quantity').focus();
    updateMealPreview();
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
