// Search functionality module
import { collection, query, where, limit, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { debounce } from './utils.js';
import { showToast } from './uiHelpers.js';
import { db, userId, foods, recipes } from './state.js';

// Funzione di utilità per calcolare lo score di pertinenza di un risultato di ricerca
const calculateSearchScore = (item, searchTerm) => {
    const name = item.name || '';
    const nameLower = name.toLowerCase();

    if (nameLower === searchTerm) return 100; // Corrispondenza esatta
    if (nameLower.startsWith(searchTerm)) return 90; // Inizia con

    const searchTokens = searchTerm.split(' ').filter(t => t.length > 0);
    if (searchTokens.some(st => (item.search_tokens || []).includes(st))) return 80; // Corrispondenza token

    if (nameLower.includes(searchTerm)) return 70; // Contiene la stringa
    return 0; // Nessuna corrispondenza forte
};

// Ordina i risultati in base allo score e poi alfabeticamente
const sortResults = (results, searchTerm) => results.sort((a, b) => calculateSearchScore(b, searchTerm) - calculateSearchScore(a, searchTerm) || a.name.localeCompare(b.name));

export function setupSearchHandler({ inputElement, resultsContainer, searchFunction, onResultClick, itemRenderer }) {
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

export async function searchFoodsOnly(searchTerm) {
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

export async function searchFoodsAndRecipes(searchTerm) {
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

        // Esegui le query in parallelo
        const [prefixSnapshot, tokenSnapshot, recipesSnapshot] = await Promise.allSettled([
            getDocs(prefixQuery),
            getDocs(tokenQuery),
            getDocs(recipesQuery)
        ]);

        const results = new Map();

        // Aggiungi risultati degli alimenti da Firestore
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

        // Aggiungi risultati delle ricette da Firestore
        if (recipesSnapshot.status === 'fulfilled') {
            recipesSnapshot.value.docs.forEach(doc => {
                const recipeData = { id: doc.id, ...doc.data(), isRecipe: true };
                results.set(`recipe-${doc.id}`, recipeData);
            });
        }

        // Aggiungi ricerca client-side per sottostringhe e token negli alimenti
        const searchTokens = lowerCaseSearchTerm.split(' ').filter(t => t.length > 0);
        foods.forEach(food => {
            if (!results.has(food.id)) {
                const nameLower = food.name_lowercase || '';
                const foodTokens = food.search_tokens || [];
                if (nameLower.includes(lowerCaseSearchTerm) || searchTokens.some(st => foodTokens.includes(st))) {
                    results.set(food.id, { ...food, isRecipe: false });
                }
            }
        });

        // Aggiungi ricerca client-side nelle ricette
        recipes.forEach(recipe => {
            const recipeKey = `recipe-${recipe.id}`;
            if (!results.has(recipeKey)) {
                const nameLower = (recipe.name || '').toLowerCase();
                if (nameLower.includes(lowerCaseSearchTerm)) {
                    results.set(recipeKey, { ...recipe, isRecipe: true });
                }
            }
        });

        const finalResults = Array.from(results.values());
        sortResults(finalResults, lowerCaseSearchTerm);

        return finalResults.slice(0, 20);
    } catch (error) {
        console.error("Errore in searchFoodsAndRecipes:", error);
        showToast("Errore durante la ricerca nel database.", true);
        return [];
    }
}

export function setupIngredientSearch(ingredientInput) {
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
            // Import and call updateRecipeBuilderMacroBar (will be handled in main script)
            if (window.updateRecipeBuilderMacroBar) {
                window.updateRecipeBuilderMacroBar();
            }
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