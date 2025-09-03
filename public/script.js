// Importa le funzioni necessarie da Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, query, where, Timestamp, doc, deleteDoc, orderBy, getDocs, setDoc, getDoc, limit, runTransaction, documentId, writeBatch, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { debounce, getDayBounds, formatDate, getMealTimestamp } from './modules/utils.js';
import { showToast, triggerFlashAnimation } from './modules/uiHelpers.js';
import { initCharts, updateCharts, destroyCharts } from './modules/charts.js';
import { firebaseConfig } from './firebase-config.js';

// --- STATO GLOBALE DELL'APPLICAZIONE ---
let app, auth, db;
let userId = null;
let currentSearchResults = [];
let currentLookupResults = [];
let selectedFood = null;
let selectedDate = new Date();
let allMeals = [];
let dailyMealsCache = {}; // Cache per i pasti giornalieri raggruppati e ordinati
let recipes = [];
let mealToEditId = null; // ID del pasto attualmente in modifica
let isOnline = navigator.onLine;
let onDecodeCallback = null;
let waterCount = 0;
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

// --- INIZIALIZZAZIONE ---

window.onload = () => {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    setupListeners();

    onAuthStateChanged(auth, async (user) => {
        const loadingOverlay = document.getElementById('loading-overlay');
        const loginScreen = document.getElementById('login-screen');
        const appContainer = document.getElementById('app');
        if (user) {
            try {
                // Resetta la data a oggi ad ogni login/refresh per coerenza.
                selectedDate = new Date();

                userId = user.uid;
                loginScreen.classList.add('hidden');
                loadingOverlay.classList.remove('hidden');
                
                updateUserUI(user);
                await loadNutritionGoals();
                listenToWaterData();
                listenToWaterHistory();
                await loadInitialData();
                
                updateDateDisplay();
                initCharts(
                    document.getElementById('calorie-chart').getContext('2d'),
                    document.getElementById('macro-chart').getContext('2d')
                );
                updateCharts(allMeals, selectedDate);

                appContainer.classList.remove('hidden');
            } catch (error) {
                console.error("Errore critico durante l'inizializzazione:", error);
                showToast("Errore durante il caricamento dell'app.", true);
            } finally {
                loadingOverlay.classList.add('hidden');
            }
        } else {
            userId = null;
            updateUserUI(null);
            appContainer.classList.add('hidden');
            loginScreen.classList.remove('hidden');
            loadingOverlay.classList.add('hidden');
            if (waterUnsubscribe) waterUnsubscribe();
            if (waterHistoryUnsubscribe) waterHistoryUnsubscribe();
            waterCount = 0;
            waterHistory = {};
            renderWaterTracker();
            resetAppData();
        }
    });
};

// --- GESTIONE EVENTI ---

function setupListeners() {
    // Navigazione date
    document.getElementById('prev-day').addEventListener('click', () => changeDay(-1));
    document.getElementById('next-day').addEventListener('click', () => changeDay(1));
    document.getElementById('today-btn').addEventListener('click', () => changeDay(0));
    document.getElementById('date-picker').addEventListener('change', (e) => {
        const [year, month, day] = e.target.value.split('-').map(Number);
        selectedDate = new Date(year, month - 1, day);
        listenToWaterData();
        updateAllUI();
    });

    // Modali e Form
    document.getElementById('edit-goals-btn').addEventListener('click', openGoalsModal);
    document.getElementById('cancel-goals-btn').addEventListener('click', closeGoalsModal);
    document.getElementById('save-goals-btn').addEventListener('click', saveAndCloseGoalsModal);

    // Calcolo automatico calorie negli obiettivi
    document.getElementById('goal-proteins').addEventListener('input', updateCalculatedCalories);
    document.getElementById('goal-carbs').addEventListener('input', updateCalculatedCalories);
    document.getElementById('goal-fats').addEventListener('input', updateCalculatedCalories);

    document.getElementById('add-ingredient-btn').addEventListener('click', addIngredientRow);
    document.getElementById('save-recipe-btn').addEventListener('click', saveRecipe);
    document.getElementById('add-food-btn').addEventListener('click', addNewFood);
    document.getElementById('add-meal-btn').addEventListener('click', addMeal);

    // Modale di conferma generico
    document.getElementById('save-edit-meal-btn').addEventListener('click', saveMealChanges);
    document.getElementById('cancel-edit-meal-btn').addEventListener('click', () => {
        document.getElementById('edit-meal-modal').classList.add('hidden');
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
    document.getElementById('scan-barcode-btn').addEventListener('click', () => startScanner(barcode => fetchFoodFromBarcode(barcode, populateMealForm)));
    document.getElementById('scan-barcode-for-new-food-btn').addEventListener('click', () => startScanner(barcode => fetchFoodFromBarcode(barcode, populateNewFoodForm)));
    document.getElementById('close-scanner-btn').addEventListener('click', stopScanner);
    document.getElementById('barcode-file-input').addEventListener('change', handleFileSelect);

    // Input di ricerca
    const foodSearchInput = document.getElementById('food-search');
    foodSearchInput.addEventListener('input', debounce(async (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const resultsContainer = document.getElementById('search-results');
        const itemRenderer = food => `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer" data-food-id="${food.id}">
                <div class="font-medium text-slate-200">${food.name}</div>
                <div class="text-sm text-slate-400">${food.calories} cal/100g</div>
            </div>
        `;
        if (searchTerm.length >= 2) {
            currentSearchResults = await handleGenericFoodSearch(searchTerm, resultsContainer, itemRenderer);
        } else {
            resultsContainer.style.display = 'none';
            currentSearchResults = [];
        }
    }, 300));

    foodSearchInput.addEventListener('focus', () => {
        document.getElementById('food-search-icon').classList.add('opacity-0');
    });
    foodSearchInput.addEventListener('blur', () => {
        if (foodSearchInput.value === '') {
            document.getElementById('food-search-icon').classList.remove('opacity-0');
        }
    });

    const foodLookupInput = document.getElementById('food-lookup-search');
    foodLookupInput.addEventListener('input', debounce(async (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const resultsContainer = document.getElementById('food-lookup-results-list');
        const detailsContainer = document.getElementById('food-lookup-details');
        const itemRenderer = food => `
            <div class="lookup-item p-4 hover:bg-slate-700 cursor-pointer" data-food-id="${food.id}">
                <div class="font-medium text-slate-200">${food.name}</div>
                <div class="text-sm text-slate-400">${food.calories} cal/100g</div>
            </div>
        `;
        if (searchTerm.length >= 2) {
            currentLookupResults = await handleGenericFoodSearch(searchTerm, resultsContainer, itemRenderer);
        } else {
            resultsContainer.style.display = 'none';
            detailsContainer.classList.add('hidden');
            currentLookupResults = [];
        }
    }, 300));
    foodLookupInput.addEventListener('focus', () => {
        document.getElementById('food-lookup-search-icon').classList.add('opacity-0');
        // Ripristina l'espansione automatica della sezione quando si fa focus sull'input
        const section = foodLookupInput.closest('.collapsible-section');
        if (section && section.classList.contains('collapsed')) {
            section.querySelector('.section-header').click();
        }
    });
    foodLookupInput.addEventListener('blur', () => {
        if (foodLookupInput.value === '') {
            document.getElementById('food-lookup-search-icon').classList.remove('opacity-0');
        }
    });

    // *** GESTIONE EVENTI CENTRALIZZATA (EVENT DELEGATION) ***
    document.body.addEventListener('click', (e) => {
        const target = e.target;

        // Nascondi i risultati della ricerca se si clicca fuori
        const searchResults = document.getElementById('search-results');
        if (searchResults.style.display === 'block' && !target.closest('#food-search-wrapper')) {
            searchResults.style.display = 'none';
        }
        const lookupResults = document.getElementById('food-lookup-results-list');
        if (lookupResults.style.display === 'block' && !target.closest('#food-lookup-wrapper')) { 
            lookupResults.style.display = 'none';
        }

        // Se clicco fuori da un pasto attivo, lo disattivo
        if (!target.closest('.meal-item')) {
            document.querySelectorAll('.meal-item.is-active').forEach(item => item.classList.remove('is-active'));
        }

        // Sezioni collassabili
        const sectionHeader = target.closest('.section-header');
        if (sectionHeader) {
            const section = sectionHeader.closest('.collapsible-section');
            // Logica migliorata: classList.toggle restituisce true se la classe è stata aggiunta (ora è collassato)
            const isNowCollapsed = section.classList.toggle('collapsed');
            sectionHeader.setAttribute('aria-expanded', String(!isNowCollapsed));
        }

        // Rimuovi ingrediente da ricetta
        const removeIngredientBtn = target.closest('.remove-ingredient-btn');
        if (removeIngredientBtn) {
            removeIngredientBtn.closest('.flex').remove();
        }

        // Gestione del "tap" sui pasti per mostrare i pulsanti su mobile
        const mealItem = target.closest('.meal-item');
        if (mealItem) {
            const isActionButton = target.closest('.meal-actions');
            // Solo se NON sto cliccando un pulsante di azione, gestisco lo stato attivo
            if (!isActionButton) {
                // Se il pasto cliccato è già attivo, lo disattivo, altrimenti attivo quello nuovo e disattivo gli altri.
                if (mealItem.classList.contains('is-active')) {
                    mealItem.classList.remove('is-active');
                } else {
                    document.querySelectorAll('.meal-item.is-active').forEach(item => item.classList.remove('is-active'));
                    mealItem.classList.add('is-active');
                }
            }
        }

        // Elimina un pasto
        const deleteMealBtn = target.closest('.delete-meal-btn');
        if (deleteMealBtn) {
            const mealId = deleteMealBtn.dataset.mealId;
            if (mealId) deleteMeal(mealId);
        }

        // Modifica un pasto
        const editMealBtn = target.closest('.edit-meal-btn');
        if (editMealBtn) {
            const mealId = editMealBtn.dataset.mealId;
            if (mealId) openEditMealModal(mealId);
        }
        
        // Elimina una ricetta
        const deleteRecipeBtn = target.closest('.delete-recipe-btn');
        if (deleteRecipeBtn) {
            const recipeId = deleteRecipeBtn.dataset.recipeId;
            if (recipeId) deleteRecipe(recipeId);
        }
        
        // Usa una ricetta
        const useRecipeBtn = target.closest('.use-recipe-btn');
        if (useRecipeBtn) {
            const recipeId = useRecipeBtn.dataset.recipeId;
            if (recipeId) useRecipe(recipeId);
        }

        // Seleziona alimento dalla ricerca pasto
        const searchItem = target.closest('.search-item');
        if (searchItem) {
            selectedFood = currentSearchResults.find(f => f.id === searchItem.dataset.foodId);
            if (selectedFood) {
                document.getElementById('food-search').value = selectedFood.name;
                document.getElementById('search-results').style.display = 'none';
                document.getElementById('meal-quantity').focus();
            }
        }

        // Seleziona alimento dalla ricerca nel database
        const lookupItem = target.closest('.lookup-item');
        if (lookupItem) {
            const food = currentLookupResults.find(f => f.id === lookupItem.dataset.foodId);
            if (food) {
                document.getElementById('food-lookup-search').value = food.name;
                showFoodLookupDetails(food);
                document.getElementById('food-lookup-results-list').style.display = 'none';
            }
        }

        // Clic su una riga dello storico
        const historyRow = target.closest('.history-row');
        if(historyRow) {
            selectedDate = new Date(historyRow.dataset.date);
            updateAllUI();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        // Clic sull'intestazione di una categoria di pasto (es. "Colazione") per
        // pre-compilare la sezione Aggiungi Pasto.
        const mealHeader = target.closest('.meal-category-header');
        if (mealHeader) {
            const mealCategoryElement = mealHeader.closest('.meal-category');
            if (mealCategoryElement) {
                const mealType = mealCategoryElement.dataset.categoryName;
                const mealTypeSelect = document.getElementById('meal-type');
                const addMealCard = document.getElementById('add-meal-card');

                if (mealType && mealTypeSelect && addMealCard) {
                    mealTypeSelect.value = mealType;
                    addMealCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    document.getElementById('food-search').focus();
                }
            }
        }
    });

    // Gestione stato online/offline
    window.addEventListener('online', () => updateOnlineStatus(true));
    window.addEventListener('offline', () => updateOnlineStatus(false));
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


// --- FUNZIONI DI MANIPOLAZIONE DATI (Firebase, API) ---

async function loadInitialData() {
    if (!userId) return;
    try {
        // Carica pasti (ultimi 30 giorni per i grafici)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const allMealsQuery = query(collection(db, `users/${userId}/meals`), where('date', '>=', Timestamp.fromDate(thirtyDaysAgo)), orderBy('date', 'desc'));
        
        onSnapshot(allMealsQuery, (snapshot) => {
            console.log(`Listener pasti: ricevuti ${snapshot.docs.length} documenti.`);
            allMeals = snapshot.docs.map(doc => {
                const data = doc.data();
                if (!data.date || typeof data.date.toDate !== 'function') {
                    console.warn(`Pasto con ID ${doc.id} ha una data non valida o mancante.`, data);
                    return null; // Scarta questo dato non valido
                }
                return { id: doc.id, ...data, jsDate: data.date.toDate() };
            }).filter(Boolean); // Rimuove tutti i pasti scartati (null)

            dailyMealsCache = {}; // Invalida la cache quando i dati dei pasti cambiano
            updateAllUI();
        }, (error) => {
            console.error("Errore nel listener dei pasti (onSnapshot):", error);
            showToast("Errore nel caricare i pasti in tempo reale.", true);
        });

        // Carica ricette
        const recipesCollection = collection(db, `users/${userId}/recipes`);
        onSnapshot(recipesCollection, (snapshot) => {
            recipes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderRecipes();
        });
    } catch (error) {
        console.error("Errore caricamento dati iniziali:", error);
        showToast("Errore nel caricare i dati.", true);
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
    const type = document.getElementById('meal-type').value;

    if (!selectedFood || isNaN(quantity) || quantity <= 0) {
        return showToast('Seleziona un alimento e inserisci una quantità valida.', true);
    }

    const addBtn = document.getElementById('add-meal-btn');
    const originalBtnHTML = addBtn.innerHTML;

    try {
        addBtn.disabled = true;
        addBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Aggiungo...`;

        const mealDate = getMealTimestamp(type, selectedDate);

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
        
        const { id, ...foodData } = selectedFood; 

        await addDoc(collection(db, `users/${userId}/meals`), {
            name: foodData.name,
            calories: foodData.calories || 0,
            proteins: foodData.proteins || 0,
            carbs: foodData.carbs || 0,
            fats: foodData.fats || 0,
            fibers: foodData.fibers || 0,
            quantity, 
            type,
            date: Timestamp.fromDate(mealDate),
            sortIndex: sortIndex
        });
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
    const newType = document.getElementById('edit-meal-type').value;

    if (isNaN(newQuantity) || newQuantity <= 0) {
        return showToast('Inserisci una quantità valida.', true);
    }

    const mealRef = doc(db, `users/${userId}/meals`, mealToEditId);
    const newDate = getMealTimestamp(newType, selectedDate);

    try {
        await updateDoc(mealRef, {
            quantity: newQuantity,
            type: newType,
            date: Timestamp.fromDate(newDate)
        });
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

        await addDoc(foodsCollectionRef, {
            name, calories, proteins, carbs, fats, fibers,
            name_lowercase: name.toLowerCase()
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

async function saveRecipe() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);

    const name = document.getElementById('recipe-name').value.trim();
    const servings = parseInt(document.getElementById('recipe-servings').value) || 1;
    if (!name) return showToast('Inserisci un nome per la ricetta.', true);
    if (servings <= 0) return showToast('Il numero di porzioni deve essere maggiore di zero.', true);
    
    const ingredients = Array.from(document.querySelectorAll('#recipe-ingredients > div'))
        .map(el => ({
            name: el.querySelector('.recipe-ingredient-name').value.trim(),
            quantity: parseFloat(el.querySelector('.recipe-ingredient-quantity').value)
        }))
        .filter(ing => ing.name && ing.quantity > 0);

    if (ingredients.length === 0) return showToast('Aggiungi almeno un ingrediente valido.', true);

    const saveBtn = document.getElementById('save-recipe-btn');
    const originalBtnHTML = saveBtn.innerHTML;

    try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Salvataggio...`;

        const totalNutrition = { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        const foodsCollection = collection(db, 'foods');
        let totalWeight = 0;

        const ingredientDataPromises = ingredients.map(async (ing) => {
            const q = query(foodsCollection, where('name_lowercase', '==', ing.name.toLowerCase()), limit(1));
            const querySnapshot = await getDocs(q);
            if (!querySnapshot.empty) {
                const foodData = querySnapshot.docs[0].data();
                const ratio = ing.quantity / 100;
                totalNutrition.calories += (foodData.calories || 0) * ratio;
                totalNutrition.proteins += (foodData.proteins || 0) * ratio;
                totalNutrition.carbs += (foodData.carbs || 0) * ratio;
                totalNutrition.fats += (foodData.fats || 0) * ratio;
                totalNutrition.fibers += (foodData.fibers || 0) * ratio;
                totalWeight += ing.quantity;
                return { ...ing, found: true };
            }
            return { ...ing, found: false };
        });

        const resolvedIngredients = await Promise.all(ingredientDataPromises);
        const notFound = resolvedIngredients.filter(ing => !ing.found);

        if (notFound.length > 0) {
            const notFoundNames = notFound.map(ing => ing.name).join(', ');
            throw new Error(`Ingredienti non trovati: ${notFoundNames}. Controlla il nome.`);
        }

        await addDoc(collection(db, `users/${userId}/recipes`), { 
            name, 
            ingredients, 
            servings,
            totalNutrition,
            totalWeight
        });
        showToast(`Ricetta "${name}" salvata!`);
        resetRecipeForm();
    } catch (error) {
        console.error("Errore salvataggio ricetta:", error);
        if (error.message.startsWith('Ingredienti non trovati')) {
            showToast(error.message, true);
        } else {
            showToast("Si è verificato un errore.", true);
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
        const foodData = {
            name: product_name || 'Nome non disponibile',
            calories: nutriments['energy-kcal_100g'] || (nutriments.energy_100g / 4.184) || 0,
            proteins: nutriments.proteins_100g || 0,
            carbs: nutriments.carbohydrates_100g || 0,
            fats: nutriments.fat_100g || 0,
            fibers: nutriments.fiber_100g || 0
        };
        
        callback(foodData);
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
    updateCharts(allMeals, selectedDate);
}

function updateUserUI(user) {
    const topBar = document.getElementById('top-bar');
    if (user) {
        document.getElementById('user-photo').src = user.photoURL || 'https://via.placeholder.com/150';
        document.getElementById('user-photo').alt = `Foto profilo di ${user.displayName}`;
        document.getElementById('user-name').textContent = user.displayName || 'Utente';
        document.getElementById('user-email').textContent = user.email;
        topBar.classList.remove('hidden');
    } else {
        topBar.classList.add('hidden');
    }
}

function updateDateDisplay() {
    const displayElement = document.getElementById('current-date-display');
    const infoElement = document.getElementById('day-info');
    const datePickerElement = document.getElementById('date-picker');
    
    displayElement.textContent = formatDate(selectedDate);
    
    const today = new Date();
    // Crea nuove date per l'inizio del giorno per evitare di modificare gli oggetti originali
    // e per garantire che vengano confrontate solo le parti della data.
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfSelectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());

    const diffTime = startOfSelectedDay.getTime() - startOfToday.getTime();
    // Usa Math.round per un calcolo più robusto della differenza di giorni, gestendo piccole differenze di orario e l'ora legale.
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        infoElement.textContent = "📅 Oggi";
    } else if (diffDays === 1) {
        infoElement.textContent = "⏭️ Domani";
    } else if (diffDays === -1) {
        infoElement.textContent = "⏮️ Ieri";
    } else if (diffDays > 0) {
        infoElement.textContent = `📆 Fra ${diffDays} giorni`;
    } else {
        infoElement.textContent = `📆 ${Math.abs(diffDays)} giorni fa`;
    }
    
    datePickerElement.value = selectedDate.toISOString().split('T')[0];
}

function renderSelectedDayMeals() {
    const container = document.getElementById('selected-day-meals');
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
        dayMeals.forEach(meal => mealsByCategory[meal.type]?.push(meal));

        // Ordina ogni categoria una sola volta, al momento della creazione della cache
        Object.values(mealsByCategory).forEach(meals => {
            meals.sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
        });

        dailyMealsCache[dateKey] = mealsByCategory; // Salva in cache
    }

    container.innerHTML = '';

    Object.entries(mealsByCategory).forEach(([categoryName, meals]) => {
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
                <div class="meal-item" data-id="${meal.id}">
                    <div class="flex justify-between items-center">
                        <div>
                            <p class="font-medium text-slate-200">${meal.name} (${Number(meal.quantity) || 0}g)</p>
                            <p class="text-sm text-slate-400 mt-1">
                                Cal: ${calculated.calories.toFixed(0)} | P: ${calculated.proteins.toFixed(1)}g | C: ${calculated.carbs.toFixed(1)}g | G: ${calculated.fats.toFixed(1)}g | F: ${calculated.fibers.toFixed(1)}g
                            </p>
                        </div>
                        <div class="meal-actions">
                            <div class="flex items-center gap-2">
                                <button class="btn-modern bg-slate-600 !py-2 !px-3 edit-meal-btn" data-meal-id="${meal.id}" aria-label="Modifica pasto">
                                    <i class="fas fa-pencil-alt"></i>
                                </button>
                                <button class="btn-modern btn-danger !py-2 !px-3 delete-meal-btn" data-meal-id="${meal.id}" aria-label="Elimina pasto">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>  
                        </div>
                    </div>
                </div>`;
            }).join('');
        } else {
            mealsHTML = `<div class="text-center text-slate-500 italic py-4">Nessun pasto registrato</div>`;
        }

        container.innerHTML += `
        <div class="meal-category" data-category-name="${categoryName}">
            <div class="meal-category-header">
                <h3 class="text-lg font-semibold text-slate-200">${categoryName}</h3>
                <div class="text-sm font-medium text-slate-400">
                    Cal: ${categoryTotals.calories.toFixed(0)} | P: ${categoryTotals.proteins.toFixed(1)}g | C: ${categoryTotals.carbs.toFixed(1)}g | G: ${categoryTotals.fats.toFixed(1)}g | F: ${categoryTotals.fibers.toFixed(1)}g
                </div>
            </div>
            <div class="p-4 space-y-3 meal-list-container">${mealsHTML}</div>
        </div>`;
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
    container.innerHTML = recipes.map(recipe => `
        <div class="recipe-card">
            <div class="flex justify-between items-start">
                <div>
                    <h4 class="font-bold text-lg text-slate-200 mb-3">${recipe.name} ${recipe.servings > 1 ? `(${recipe.servings} porzioni)` : ''}</h4>
                    <ul class="mt-2 text-sm text-slate-400 list-disc pl-5 space-y-1">
                        ${recipe.ingredients.map(ing => `<li>${ing.name}: ${ing.quantity}g</li>`).join('')}
                    </ul>
                    ${recipe.totalNutrition && recipe.totalWeight && recipe.servings ? `
                    <div class="mt-4 pt-4 border-t border-slate-700">
                        <p class="font-semibold text-slate-300 mb-2">Per porzione (~${(recipe.totalWeight / recipe.servings).toFixed(0)}g):</p>
                        <p class="text-sm text-slate-400">
                            Cal: ${(recipe.totalNutrition.calories / recipe.servings).toFixed(0)} | P: ${(recipe.totalNutrition.proteins / recipe.servings).toFixed(1)}g | C: ${(recipe.totalNutrition.carbs / recipe.servings).toFixed(1)}g | G: ${(recipe.totalNutrition.fats / recipe.servings).toFixed(1)}g | F: ${(recipe.totalNutrition.fibers / recipe.servings).toFixed(1)}g
                        </p>
                    </div>
                    ` : ''}
                </div>
                <div class="flex space-x-3">
                    <button class="btn-modern btn-primary !py-2 !px-3 use-recipe-btn" data-recipe-id="${recipe.id}" aria-label="Usa ricetta">
                        <i class="fas fa-plus"></i>
                    </button>
                    <button class="btn-modern btn-danger !py-2 !px-3 delete-recipe-btn" data-recipe-id="${recipe.id}" aria-label="Elimina ricetta">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

function renderWeeklyHistory() {
    const container = document.getElementById('weekly-history');
    container.innerHTML = '';
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const { start, end } = getDayBounds(date);
        const dayMeals = allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end);
        
        const totals = dayMeals.reduce((acc, meal) => {
            const ratio = (Number(meal.quantity) || 0) / 100;
            acc.calories += (Number(meal.calories) || 0) * ratio;
            acc.proteins += (Number(meal.proteins) || 0) * ratio;
            acc.carbs += (Number(meal.carbs) || 0) * ratio;
            acc.fats += (Number(meal.fats) || 0) * ratio;
            acc.fibers += (Number(meal.fibers) || 0) * ratio;
            return acc;
        }, { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 });

        const isToday = date.toDateString() === new Date().toDateString();
        const dateClass = isToday ? 'font-bold text-indigo-400' : '';
        
        const row = document.createElement('tr');
        row.className = 'table-row history-row';
        row.dataset.date = date.toISOString();
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm ${dateClass}">${date.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })} ${isToday ? '(Oggi)' : ''}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.calories.toFixed(0)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.proteins.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.carbs.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.fats.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${totals.fibers.toFixed(1)}g</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${waterHistory[date.toISOString().split('T')[0]] || 0} bicchieri</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-400">${dayMeals.length} pasti</td>
        `;
        container.appendChild(row);
    }
}

function updateNutritionProgress() {
    const { start, end } = getDayBounds(selectedDate);
    const dayMeals = allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end);
    
    const totals = dayMeals.reduce((acc, meal) => {
        const ratio = (Number(meal.quantity) || 0) / 100;
        acc.calories += (Number(meal.calories) || 0) * ratio;
        acc.proteins += (Number(meal.proteins) || 0) * ratio;
        acc.carbs += (Number(meal.carbs) || 0) * ratio;
        acc.fats += (Number(meal.fats) || 0) * ratio;
        acc.fibers += (Number(meal.fibers) || 0) * ratio;
        return acc;
    }, { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 });
    
    // Aggiorna i totali principali
    const updateAndAnimateTotal = (id, value, decimals = 0) => {
        document.getElementById(id).textContent = value.toFixed(decimals);
        triggerFlashAnimation(id);
    };

    updateAndAnimateTotal('total-calories', totals.calories, 0);
    updateAndAnimateTotal('total-proteins', totals.proteins, 1);
    updateAndAnimateTotal('total-carbs', totals.carbs, 1);
    updateAndAnimateTotal('total-fats', totals.fats, 1);
    updateAndAnimateTotal('total-fibers', totals.fibers, 1);

    // Aggiorna le barre di progresso
    const updateProgress = (type, value) => {
        const percent = Math.min(100, (value / nutritionGoals[type]) * 100);
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

function changeDay(offset) {
    if (offset === 0) { // Vai a oggi
        selectedDate = new Date();
    } else {
        selectedDate.setDate(selectedDate.getDate() + offset);
    }
    listenToWaterData();
    updateAllUI();
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
    document.getElementById('lookup-food-name').textContent = food.name;
    document.getElementById('lookup-food-calories').textContent = food.calories;
    document.getElementById('lookup-food-proteins').textContent = food.proteins;
    document.getElementById('lookup-food-carbs').textContent = food.carbs;
    document.getElementById('lookup-food-fats').textContent = food.fats;
    document.getElementById('lookup-food-fibers').textContent = food.fibers || 0;
    detailsContainer.classList.remove('hidden');
}

async function setWaterCount(newCount) {
    if (newCount < 0 || isNaN(newCount)) return;

    if (!userId || !isOnline) {
        if (!isOnline) showToast("Sei offline. Il conteggio non verrà salvato.", true);
        return;
    }
    const dateString = selectedDate.toISOString().split('T')[0];
    const waterDocRef = doc(db, `users/${userId}/water`, dateString);
    try {
        await setDoc(waterDocRef, { count: newCount }, { merge: true });
    } catch (error) {
        console.error("Errore salvataggio acqua (setWaterCount):", error);
        showToast("Errore nel salvare il conteggio dell'acqua.", true);
    }
}

async function incrementWaterCount(amount) {
    if (!userId || !isOnline) {
        if (!isOnline) showToast("Sei offline. Il conteggio non verrà salvato.", true);
        return;
    }

    const dateString = selectedDate.toISOString().split('T')[0];
    const waterDocRef = doc(db, `users/${userId}/water`, dateString);
    
    try {
        await runTransaction(db, async (transaction) => {
            const waterDoc = await transaction.get(waterDocRef);
            const currentCount = waterDoc.data()?.count || 0;
            const newCount = currentCount + amount;
            const finalCount = Math.max(0, newCount);

            // Impedisce al conteggio di scendere sotto lo zero.
            transaction.set(waterDocRef, { count: finalCount }, { merge: true });
        });
    } catch (e) {
        console.error("Transazione acqua fallita: ", e);
        showToast("Errore nell'aggiornare il conteggio dell'acqua.", true);
    }
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
        const oldCount = waterCount; // Salva il valore precedente
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

    document.getElementById('edit-meal-name').textContent = meal.name;
    document.getElementById('edit-meal-quantity').value = meal.quantity;
    document.getElementById('edit-meal-type').value = meal.type;

    document.getElementById('edit-meal-modal').classList.remove('hidden');
    document.getElementById('edit-meal-quantity').focus();
}

function openGoalsModal() {
    updateCalculatedCalories(); // Calcola subito all'apertura
    document.getElementById('goals-modal').classList.remove('hidden');
    document.getElementById('goal-proteins').focus(); // Focus sul primo campo modificabile
}

function closeGoalsModal() {
    document.getElementById('goals-modal').classList.add('hidden');
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
}

function hideConfirmationModal() {
    document.getElementById('confirmation-modal').classList.add('hidden');
    onConfirmAction = null;
}

function executeConfirmAction() {
    if (typeof onConfirmAction === 'function') {
        onConfirmAction();
    }
    hideConfirmationModal();
}

function addIngredientRow() {
    const container = document.getElementById('recipe-ingredients');
    const newIngredient = document.createElement('div');
    newIngredient.className = 'flex gap-3';
    newIngredient.innerHTML = `
        <input type="text" class="recipe-ingredient-name input-modern flex-1" placeholder="Ingrediente">
        <input type="number" class="recipe-ingredient-quantity input-modern w-24" placeholder="g">
        <button type="button" class="btn-modern btn-danger !py-2 !px-3 remove-ingredient-btn" aria-label="Rimuovi ingrediente">
            <i class="fas fa-trash"></i>
        </button>`;
    container.appendChild(newIngredient);
    newIngredient.querySelector('.recipe-ingredient-name').focus();
}

function resetAddMealForm() {
    document.getElementById('food-search').value = '';
    document.getElementById('meal-quantity').value = '';
    selectedFood = null;
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('food-search').focus();
}

function resetNewFoodForm() {
    ['new-food-name', 'new-food-calories', 'new-food-proteins', 'new-food-carbs', 'new-food-fats', 'new-food-fibers']
        .forEach(id => document.getElementById(id).value = '');
    document.getElementById('new-food-name').focus();
}

function resetRecipeForm() {
    document.getElementById('recipe-name').value = '';
    document.getElementById('recipe-servings').value = '1';
    const ingredientsContainer = document.getElementById('recipe-ingredients');
    ingredientsContainer.innerHTML = ''; // Svuota tutto
    addIngredientRow(); // Aggiunge la prima riga vuota
    document.getElementById('recipe-name').focus();
}

// --- Funzioni di ricerca ---

/**
 * Funzione generica per la ricerca di alimenti nel database Firestore.
 * @param {string} searchTerm - Il termine da cercare (in minuscolo).
 * @param {HTMLElement} resultsContainer - L'elemento contenitore per i risultati.
 * @param {function(object): string} itemRenderer - Una funzione che prende un oggetto 'food' e restituisce una stringa HTML per quell'elemento.
 * @returns {Promise<Array>} Una promise che si risolve con l'array dei risultati.
 */
async function handleGenericFoodSearch(searchTerm, resultsContainer, itemRenderer) {
    if (searchTerm.length < 2) {
        resultsContainer.style.display = 'none';
        return [];
    }

    try {
        const q = query(
            collection(db, 'foods'),
            where('name_lowercase', '>=', searchTerm),
            where('name_lowercase', '<=', searchTerm + '\uf8ff'),
            orderBy('name_lowercase'),
            limit(10)
        );
        const querySnapshot = await getDocs(q);
        const results = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (results.length > 0) {
            resultsContainer.innerHTML = results.map(itemRenderer).join('');
        } else {
            resultsContainer.innerHTML = `<div class="p-4 text-slate-500">Nessun alimento trovato.</div>`;
        }
        resultsContainer.style.display = 'block';
        return results;
    } catch (error) {
        console.error("Errore ricerca alimento:", error);
        showToast("Errore durante la ricerca.", true);
        return [];
    }
}

// --- Funzioni Scanner ---

function startScanner(onDecode) {
    if (typeof Html5Qrcode === 'undefined') {
        return showToast("Libreria di scansione non caricata.", true);
    }
    onDecodeCallback = onDecode;
    document.getElementById('barcode-file-input').click();
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const modal = document.getElementById('scanner-modal');
    modal.classList.remove('hidden');
    
    const html5QrCode = new Html5Qrcode("scanner-container");
    try {
        const decodedText = await html5QrCode.scanFile(file, false);
        showToast(`Codice trovato!`);
        if (onDecodeCallback) {
            onDecodeCallback(decodedText);
        }
    } catch (err) {
        console.error("Errore scansione file:", err);
        showToast("Nessun codice a barre trovato nell'immagine.", true);
    } finally {
        modal.classList.add('hidden');
        onDecodeCallback = null;
        event.target.value = ''; // Permette di ricaricare lo stesso file
    }
}

function stopScanner() {
    document.getElementById('scanner-modal').classList.add('hidden');
}

function populateMealForm(foodData) {
    document.getElementById('food-search').value = foodData.name;
    document.getElementById('meal-quantity').value = 100;
    selectedFood = foodData;
    showToast(`Prodotto trovato: ${foodData.name}`);
    document.getElementById('meal-quantity').focus();
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
