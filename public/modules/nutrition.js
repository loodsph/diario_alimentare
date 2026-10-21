// Calcoli nutrizionali puri (nessun accesso a DOM o Firestore).

export const NUTRIENT_KEYS = ['calories', 'proteins', 'carbs', 'fats', 'fibers'];

// Limite della query Firestore `in` usata per caricare gli ingredienti.
export const MAX_RECIPE_INGREDIENTS = 30;

export function emptyTotals() {
    return { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 };
}

// I pasti salvati da alimenti CREA possono avere solo i campi originali italiani.
const CREA_FALLBACKS = {
    calories: 'energia_kcal',
    proteins: 'proteine_g',
    carbs: 'carboidrati_disponibili_g',
    fats: 'lipidi_g',
    fibers: 'fibra_totale_g'
};

// Valori nutrizionali effettivi di un pasto (valori per 100 g × quantità).
export function mealNutrition(meal) {
    const ratio = (Number(meal.quantity) || 0) / 100;
    const result = emptyTotals();
    for (const key of NUTRIENT_KEYS) {
        result[key] = (Number(meal[key] ?? meal[CREA_FALLBACKS[key]] ?? 0) || 0) * ratio;
    }
    return result;
}

export function addTotals(target, values) {
    for (const key of NUTRIENT_KEYS) target[key] += values[key];
    return target;
}

export function findMissingIngredients(ingredients, foodDataMap) {
    return ingredients.filter(ing => !ing.foodId || !foodDataMap.has(ing.foodId));
}

// Totali della ricetta a partire dagli ingredienti (quantità in g) e dai dati per 100 g.
export function computeRecipeNutrition(ingredients, foodDataMap) {
    const totalNutrition = emptyTotals();
    let totalWeight = 0;
    for (const ing of ingredients) {
        const foodData = foodDataMap.get(ing.foodId);
        if (!foodData) continue;
        const ratio = ing.quantity / 100;
        for (const key of NUTRIENT_KEYS) totalNutrition[key] += (foodData[key] || 0) * ratio;
        totalWeight += ing.quantity;
    }
    return { totalNutrition, totalWeight };
}

// Nomi, unità, icone e gruppi per la scheda dettagliata di un alimento.
export const NUTRIENT_INFO = {
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

const NUTRIENT_GROUPS = [
    { key: 'macro', title: 'Macronutrienti Principali' },
    { key: 'mineral', title: 'Minerali' },
    { key: 'vitamin', title: 'Vitamine' },
    { key: 'other', title: 'Altri Nutrienti' }
];

const EXCLUDED_DETAIL_FIELDS = new Set(['name', 'name_lowercase', 'original_id', 'source_url', 'energia_kj']);

// Raggruppa i valori numerici positivi di un alimento per la scheda dettagliata.
// Restituisce solo i gruppi non vuoti, nell'ordine di visualizzazione.
export function groupNutrientDetails(food) {
    const groups = new Map(NUTRIENT_GROUPS.map(group => [group.key, { title: group.title, items: [] }]));
    for (const key of Object.keys(food)) {
        if (EXCLUDED_DETAIL_FIELDS.has(key) || typeof food[key] !== 'number' || !(food[key] > 0)) continue;
        const info = NUTRIENT_INFO[key];
        groups.get(info ? info.group : 'other').items.push({ key, value: food[key], ...info });
    }
    // I macronutrienti principali vanno per primi e nell'ordine canonico.
    groups.get('macro').items.sort((a, b) => {
        const indexA = NUTRIENT_KEYS.indexOf(a.key);
        const indexB = NUTRIENT_KEYS.indexOf(b.key);
        if (indexA === -1 && indexB === -1) return a.name.localeCompare(b.name);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });
    return [...groups.values()].filter(group => group.items.length > 0);
}
