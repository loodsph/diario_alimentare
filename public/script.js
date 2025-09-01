// Importa le funzioni necessarie da Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, query, where, Timestamp, doc, deleteDoc, orderBy, getDocs, setDoc, getDoc, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

// --- STATO GLOBALE DELL'APPLICAZIONE ---
let app, auth, db;
let userId = null;
let currentSearchResults = [];
let currentLookupResults = [];
let selectedFood = null;
let selectedDate = new Date();
let allMeals = [];
let recipes = [];
let calorieChart = null;
let macroChart = null;
let isOnline = navigator.onLine;
let onDecodeCallback = null;

let nutritionGoals = {
    calories: 2000,
    proteins: 150,
    carbs: 250,
    fats: 70,
    fibers: 30
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
                userId = user.uid;
                loginScreen.classList.add('hidden');
                loadingOverlay.classList.remove('hidden');
                
                updateUserUI(user);
                await loadNutritionGoals();
                await loadInitialData();
                
                updateDateDisplay();
                if (!calorieChart) initCharts();
                else updateCharts();

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
        updateAllUI();
    });

    // Modali e Form
    document.getElementById('edit-goals-btn').addEventListener('click', openGoalsModal);
    document.getElementById('cancel-goals-btn').addEventListener('click', closeGoalsModal);
    document.getElementById('save-goals-btn').addEventListener('click', saveAndCloseGoalsModal);
    document.getElementById('add-ingredient-btn').addEventListener('click', addIngredientRow);
    document.getElementById('save-recipe-btn').addEventListener('click', saveRecipe);
    document.getElementById('add-food-btn').addEventListener('click', addNewFood);
    document.getElementById('add-meal-btn').addEventListener('click', addMeal);

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
    foodSearchInput.addEventListener('input', handleSearch);
    foodSearchInput.addEventListener('focus', () => {
        document.getElementById('food-search-icon').classList.add('opacity-0');
    });
    foodSearchInput.addEventListener('blur', () => {
        if (foodSearchInput.value === '') {
            document.getElementById('food-search-icon').classList.remove('opacity-0');
        }
    });

    const foodLookupInput = document.getElementById('food-lookup-search');
    foodLookupInput.addEventListener('input', handleFoodLookup);
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

        // Elimina un pasto
        const deleteMealBtn = target.closest('.delete-meal-btn');
        if (deleteMealBtn) {
            const mealId = deleteMealBtn.dataset.mealId;
            if (mealId) deleteMeal(mealId);
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
            nutritionGoals = docSnap.data();
        } else {
            await setDoc(goalsDoc, nutritionGoals);
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

    const mealDate = getMealTimestamp(type);
    
    // Destructure to remove 'id' and avoid overwriting the meal's document ID
    const { id, ...foodData } = selectedFood;

    try {
        await addDoc(collection(db, `users/${userId}/meals`), {
            ...foodData,
            quantity,
            type,
            date: Timestamp.fromDate(mealDate)
        });
        showToast('Pasto aggiunto al diario!');
        resetAddMealForm();
    } catch (error) {
        console.error("Errore aggiunta pasto:", error);
        showToast("Si è verificato un errore.", true);
    }
}

async function deleteMeal(mealId) {
    if (!isOnline) return showToast("Sei offline. Impossibile eliminare.", true);
    try {
        await deleteDoc(doc(db, `users/${userId}/meals`, mealId));
        showToast('Pasto eliminato con successo!');
    } catch (error) {
        console.error("Errore eliminazione pasto:", error);
        showToast("Errore durante l'eliminazione.", true);
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
    
    try {
        await addDoc(collection(db, 'foods'), { 
            name, calories, proteins, carbs, fats, fibers,
            name_lowercase: name.toLowerCase() // Aggiunge il campo per la ricerca
        });
        showToast(`${name} aggiunto al database!`);
        resetNewFoodForm();
    } catch (error) {
        console.error("Errore aggiunta alimento:", error);
        showToast("Si è verificato un errore.", true);
    }
}

async function saveRecipe() {
    if (!isOnline) return showToast("Sei offline. Impossibile salvare.", true);

    const name = document.getElementById('recipe-name').value.trim();
    if (!name) return showToast('Inserisci un nome per la ricetta.', true);
    
    const ingredients = Array.from(document.querySelectorAll('#recipe-ingredients > div'))
        .map(el => ({
            name: el.querySelector('.recipe-ingredient-name').value.trim(),
            quantity: parseInt(el.querySelector('.recipe-ingredient-quantity').value)
        }))
        .filter(ing => ing.name && ing.quantity > 0);

    if (ingredients.length === 0) return showToast('Aggiungi almeno un ingrediente valido.', true);

    try {
        await addDoc(collection(db, `users/${userId}/recipes`), { name, ingredients });
        showToast(`Ricetta "${name}" salvata!`);
        resetRecipeForm();
    } catch (error) {
        console.error("Errore salvataggio ricetta:", error);
        showToast("Si è verificato un errore.", true);
    }
}

async function deleteRecipe(recipeId) {
    if (!isOnline) return showToast("Sei offline. Impossibile eliminare.", true);
    try {
        await deleteDoc(doc(db, `users/${userId}/recipes`, recipeId));
        showToast('Ricetta eliminata con successo!');
    } catch (error) {
        console.error("Errore eliminazione ricetta:", error);
        showToast("Errore durante l'eliminazione.", true);
    }
}

async function useRecipe(recipeId) {
    if (!isOnline) return showToast("Sei offline. Impossibile usare la ricetta.", true);
    
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) return showToast("Errore: Ricetta non trovata.", true);

    const mealType = document.getElementById('meal-type').value;
    const mealDate = getMealTimestamp(mealType);

    showToast(`Aggiungo la ricetta "${recipe.name}"...`);

    for (const ingredient of recipe.ingredients) {
        // Cerca l'alimento nel database in tempo reale
        const foodsCollection = collection(db, 'foods');
        const q = query(foodsCollection, where('name_lowercase', '==', ingredient.name.toLowerCase()));
        const querySnapshot = await getDocs(q);

        if (!querySnapshot.empty) {
            const foodDoc = querySnapshot.docs[0];
            const food = { id: foodDoc.id, ...foodDoc.data() };
            const { id, ...foodData } = food;
            try {
                await addDoc(collection(db, `users/${userId}/meals`), {
                    ...foodData,
                    quantity: ingredient.quantity,
                    type: mealType,
                    date: Timestamp.fromDate(mealDate)
                });
            } catch (error) {
                console.error(`Errore aggiunta ingrediente "${ingredient.name}":`, error);
            }
        } else {
            console.warn(`Ingrediente non trovato nel DB: ${ingredient.name}`);
        }
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
    updateCharts();
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
    const diffTime = selectedDate.getTime() - today.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
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
    const { start, end } = getDayBounds(selectedDate);
    const dayMeals = allMeals.filter(meal => meal.jsDate >= start && meal.jsDate <= end);
    container.innerHTML = '';

    const mealsByCategory = { '🌅 Colazione': [], '🍽️ Pranzo': [], '🌙 Cena': [], '🍪 Spuntino': [] };
    dayMeals.forEach(meal => mealsByCategory[meal.type]?.push(meal));

    Object.entries(mealsByCategory).forEach(([categoryName, meals]) => {
        const categoryTotals = { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
        let mealsHTML = '';

        if (meals.length > 0) {
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
                <div class="meal-item">
                    <div class="flex justify-between items-center">
                        <div>
                            <p class="font-medium text-slate-200">${meal.name} (${Number(meal.quantity) || 0}g)</p>
                            <p class="text-sm text-slate-400 mt-1">
                                Cal: ${calculated.calories.toFixed(0)} | P: ${calculated.proteins.toFixed(1)}g | C: ${calculated.carbs.toFixed(1)}g | G: ${calculated.fats.toFixed(1)}g
                            </p>
                        </div>
                        <button class="btn-modern btn-danger !py-2 !px-3 delete-meal-btn" data-meal-id="${meal.id}" aria-label="Elimina pasto">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>`;
            }).join('');
        } else {
            mealsHTML = `<div class="text-center text-slate-500 italic py-4">Nessun pasto registrato</div>`;
        }

        container.innerHTML += `
        <div class="meal-category">
            <div class="meal-category-header">
                <h3 class="text-lg font-semibold text-slate-200">${categoryName}</h3>
                <div class="text-sm font-medium text-slate-400">
                    Cal: ${categoryTotals.calories.toFixed(0)} | P: ${categoryTotals.proteins.toFixed(1)}g | C: ${categoryTotals.carbs.toFixed(1)}g | G: ${categoryTotals.fats.toFixed(1)}g
                </div>
            </div>
            <div class="p-4 space-y-3">${mealsHTML}</div>
        </div>`;
    });

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
                    <h4 class="font-bold text-lg text-slate-200 mb-3">${recipe.name}</h4>
                    <ul class="mt-2 text-sm text-slate-400 list-disc pl-5 space-y-1">
                        ${recipe.ingredients.map(ing => `<li>${ing.name}: ${ing.quantity}g</li>`).join('')}
                    </ul>
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
    document.getElementById('total-calories').textContent = totals.calories.toFixed(0);
    document.getElementById('total-proteins').textContent = totals.proteins.toFixed(1);
    document.getElementById('total-carbs').textContent = totals.carbs.toFixed(1);
    document.getElementById('total-fats').textContent = totals.fats.toFixed(1);
    document.getElementById('total-fibers').textContent = totals.fibers.toFixed(1);

    // Aggiorna le barre di progresso
    const updateProgress = (type, value) => {
        const percent = Math.min(100, (value / nutritionGoals[type]) * 100);
        document.getElementById(`${type}-progress`).style.width = `${percent}%`;
        document.getElementById(`${type}-progress-text`).textContent = `${value.toFixed(type === 'calories' ? 0 : 1)}${type !== 'calories' ? 'g' : ''}/${nutritionGoals[type]}${type !== 'calories' ? 'g' : ''}`;
    };

    updateProgress('calories', totals.calories);
    updateProgress('proteins', totals.proteins);
    updateProgress('carbs', totals.carbs);
    updateProgress('fats', totals.fats);
    updateProgress('fibers', totals.fibers);
}


// --- FUNZIONI UTILITY E HELPERS ---

function changeDay(offset) {
    if (offset === 0) { // Vai a oggi
        selectedDate = new Date();
    } else {
        selectedDate.setDate(selectedDate.getDate() + offset);
    }
    updateAllUI();
}

function getDayBounds(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

function formatDate(date) {
    return date.toLocaleDateString('it-IT', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const iconContainer = toast.querySelector('div');
    const icon = toast.querySelector('i');
    const text = toast.querySelector('span');

    text.textContent = message;

    if (isError) {
        iconContainer.className = 'w-8 h-8 rounded-full bg-gradient-to-r from-red-500 to-pink-500 flex items-center justify-center';
        icon.className = 'fas fa-exclamation-circle text-white text-sm';
    } else {
        iconContainer.className = 'w-8 h-8 rounded-full bg-gradient-to-r from-green-400 to-emerald-500 flex items-center justify-center';
        icon.className = 'fas fa-check text-white text-sm';
    }

    toast.classList.remove('opacity-0', 'translate-y-10');

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-10');
    }, 3000);
}

function resetAppData() {
    allMeals = []; recipes = [];
    if (calorieChart) { calorieChart.destroy(); calorieChart = null; }
    if (macroChart) { macroChart.destroy(); macroChart = null; }
    document.getElementById('selected-day-meals').innerHTML = '';
    document.getElementById('saved-recipes').innerHTML = '';
    document.getElementById('weekly-history').innerHTML = '';
}

function getMealTimestamp(type) {
    let mealDate = new Date(selectedDate);
    if (selectedDate.toDateString() === new Date().toDateString()) {
        return new Date(); // Ora corrente se è oggi
    }
    const defaultTimes = {
        '🌅 Colazione': 8, '🍽️ Pranzo': 13, '🌙 Cena': 20, '🍪 Spuntino': 16
    };
    mealDate.setHours(defaultTimes[type] || 12, 0, 0, 0);
    return mealDate;
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

// ... (altre funzioni di UI come modali, form resets, grafici, etc.)
// ... (tutte le altre funzioni da qui in poi)

function openGoalsModal() {
    document.getElementById('goals-modal').classList.remove('hidden');
    document.getElementById('goal-calories').focus();
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
}

async function saveAndCloseGoalsModal() {
    nutritionGoals.calories = parseInt(document.getElementById('goal-calories').value) || 2000;
    nutritionGoals.proteins = parseInt(document.getElementById('goal-proteins').value) || 150;
    nutritionGoals.carbs = parseInt(document.getElementById('goal-carbs').value) || 250;
    nutritionGoals.fats = parseInt(document.getElementById('goal-fats').value) || 70;
    nutritionGoals.fibers = parseInt(document.getElementById('goal-fibers').value) || 30;
    await saveNutritionGoals();
    updateNutritionProgress();
    document.getElementById('goals-modal').classList.add('hidden');
    showToast('Obiettivi aggiornati con successo!');
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
    const ingredientsContainer = document.getElementById('recipe-ingredients');
    ingredientsContainer.innerHTML = ''; // Svuota tutto
    addIngredientRow(); // Aggiunge la prima riga vuota
    document.getElementById('recipe-name').focus();
}

// --- Funzioni per i grafici ---

function initCharts() {
    const defaultOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            y: {
                beginAtZero: true,
                grid: { color: 'rgba(148, 163, 184, 0.1)' },
                ticks: { color: '#94a3b8' }
            },
            x: {
                grid: { display: false },
                ticks: { color: '#94a3b8' }
            }
        }
    };

    const calorieCtx = document.getElementById('calorie-chart').getContext('2d');
    calorieChart = new Chart(calorieCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Calorie', data: [],
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                tension: 0.4, fill: true
            }]
        },
        options: defaultOptions
    });

    const macroCtx = document.getElementById('macro-chart').getContext('2d');
    macroChart = new Chart(macroCtx, {
        type: 'doughnut',
        data: {
            labels: ['Proteine', 'Carboidrati', 'Grassi'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
                borderColor: ['#059669', '#d97706', '#dc2626'],
                borderWidth: 2,
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { padding: 20, color: '#94a3b8' } } },
            cutout: '70%'
        }
    });
}

function updateCharts() {
    if (!calorieChart || !macroChart) return;
    
    // Grafico calorie (ultimi 7 giorni)
    const calorieLabels = [];
    const calorieData = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const { start, end } = getDayBounds(date);
        const dayCalories = allMeals
            .filter(meal => meal.jsDate >= start && meal.jsDate <= end)
            .reduce((sum, meal) => sum + ((Number(meal.calories) || 0) * (Number(meal.quantity) || 0) / 100), 0);
        calorieLabels.push(date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }));
        calorieData.push(dayCalories.toFixed(0));
    }
    calorieChart.data.labels = calorieLabels;
    calorieChart.data.datasets[0].data = calorieData;
    calorieChart.update();

    // Grafico macro (giorno selezionato)
    const { start, end } = getDayBounds(selectedDate);
    const dayTotals = allMeals
        .filter(meal => meal.jsDate >= start && meal.jsDate <= end)
        .reduce((acc, meal) => {
            const ratio = (Number(meal.quantity) || 0) / 100;
            acc.proteins += (Number(meal.proteins) || 0) * ratio;
            acc.carbs += (Number(meal.carbs) || 0) * ratio;
            acc.fats += (Number(meal.fats) || 0) * ratio;
            return acc;
        }, { proteins: 0, carbs: 0, fats: 0 });
    
    macroChart.data.datasets[0].data = [
        dayTotals.proteins,
        dayTotals.carbs,
        dayTotals.fats
    ];
    macroChart.update();
}


// --- Funzioni di ricerca ---

async function handleSearch(e) {
    const searchTerm = e.target.value.toLowerCase();
    const resultsContainer = document.getElementById('search-results');
    
    if (searchTerm.length < 2) {
        resultsContainer.style.display = 'none';
        currentSearchResults = [];
        return;
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
        currentSearchResults = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (currentSearchResults.length > 0) {
            resultsContainer.innerHTML = currentSearchResults.map(food => `
            <div class="search-item p-4 hover:bg-slate-700 cursor-pointer" data-food-id="${food.id}">
                <div class="font-medium text-slate-200">${food.name}</div>
                <div class="text-sm text-slate-400">${food.calories} cal/100g</div>
            </div>
        `).join('');
            resultsContainer.style.display = 'block';
        } else {
            resultsContainer.innerHTML = `<div class="p-4 text-slate-500">Nessun alimento trovato.</div>`;
            resultsContainer.style.display = 'block';
        }
    } catch (error) {
        console.error("Errore ricerca alimento:", error);
        showToast("Errore durante la ricerca.", true);
    }
}

async function handleFoodLookup(e) {
    const searchTerm = e.target.value.toLowerCase();
    const resultsContainer = document.getElementById('food-lookup-results-list');
    const detailsContainer = document.getElementById('food-lookup-details');

    if (searchTerm.length < 2) {
        resultsContainer.style.display = 'none';
        detailsContainer.classList.add('hidden');
        currentLookupResults = [];
        return;
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
        currentLookupResults = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (currentLookupResults.length > 0) {
            resultsContainer.innerHTML = currentLookupResults.map(food => `
            <div class="lookup-item p-4 hover:bg-slate-700 cursor-pointer" data-food-id="${food.id}">
                <div class="font-medium text-slate-200">${food.name}</div>
                <div class="text-sm text-slate-400">${food.calories} cal/100g</div>
            </div>
        `).join('');
            resultsContainer.style.display = 'block';
        } else {
            resultsContainer.innerHTML = `<div class="p-4 text-slate-500">Nessun alimento trovato.</div>`;
            resultsContainer.style.display = 'block';
            detailsContainer.classList.add('hidden');
        }
    } catch (error) {
        console.error("Errore ricerca alimento:", error);
        showToast("Errore durante la ricerca.", true);
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