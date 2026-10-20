// Nutrition stays per 100 g; portion metadata records how the user chose that weight.
export const nutrientKeys = ['calories', 'proteins', 'carbs', 'fats', 'fibers'];
export const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
export const formatAmount = value => Number(value).toLocaleString('it-IT', { maximumFractionDigits: 2 });

export function recipeWeight(food) {
    return positive(food.finalWeight) ? Number(food.finalWeight) : Number(food.totalWeight);
}

export function nutritionPer100g(food) {
    if (!food.isRecipe) return Object.fromEntries(nutrientKeys.map(key => [key, Number(food[key]) || 0]));
    const weight = recipeWeight(food);
    if (!positive(weight) || !positive(food.servings) || !food.totalNutrition) {
        throw new Error('Ricetta incompleta: controlla ingredienti e numero di porzioni.');
    }
    return Object.fromEntries(nutrientKeys.map(key => [key, (Number(food.totalNutrition[key]) || 0) * 100 / weight]));
}

export function foodKey(food) {
    if (food.isRecipe || food.recipeId) return `recipe:${food.recipeId || food.id}`;
    if (food.barcode) return `barcode:${food.barcode}`;
    if (food.foodId || food.id) return `food:${food.foodId || food.id}`;
    return `name:${food.name.trim().toLocaleLowerCase('it')}`;
}

export function portionOptions(food = {}, customUnit = null) {
    const options = [{ id: 'g', label: 'Grammi', grams: 1, source: 'Peso inserito' }];
    if (food.isRecipe && positive(recipeWeight(food)) && positive(food.servings)) {
        const source = positive(food.finalWeight) ? 'Peso finale della ricetta' : 'Somma degli ingredienti, non peso cotto';
        options.push({ id: 'serving', label: 'Porzioni della ricetta', grams: recipeWeight(food) / food.servings, source });
        options.push({ id: 'recipe', label: 'Ricetta intera', grams: recipeWeight(food), source });
    } else if (positive(food.servingGrams)) {
        options.push({ id: 'serving', label: food.servingLabel || 'Porzioni del prodotto', grams: Number(food.servingGrams), source: 'Dati del prodotto' });
    }
    if (positive(food.packageGrams)) {
        options.push({ id: 'package', label: 'Confezioni', grams: Number(food.packageGrams), source: 'Peso netto del prodotto' });
    }
    if (customUnit && positive(customUnit.grams) && typeof customUnit.label === 'string') {
        options.push({ id: 'custom', label: customUnit.label, grams: Number(customUnit.grams), source: 'Misura definita da te' });
    }
    return options;
}

export function quantityInGrams(amount, unit) {
    if (!positive(amount) || !unit || !positive(unit.grams)) return NaN;
    const grams = Number(amount) * Number(unit.grams);
    return positive(grams) ? grams : NaN;
}

export function portionDescription(portion) {
    if (!portion || !positive(portion.amount) || !positive(portion.gramsPerUnit)) return '';
    if (portion.ingredientWeight) {
        return portion.unitId === 'g' ? `${formatAmount(portion.amount)} g di ingredienti`
            : `${formatAmount(portion.amount)} × ${portion.label} · peso cotto non registrato`;
    }
    if (portion.unitId === 'g') return `${formatAmount(portion.amount)} g`;
    return `${formatAmount(portion.amount)} × ${portion.label} · ${formatAmount(portion.amount * portion.gramsPerUnit)} g`;
}

// Only explicit masses are accepted. A volume must never silently become grams.
export function massInGrams(value) {
    const match = String(value || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
    if (!match) return null;
    const grams = Number(match[1].replace(',', '.')) * (match[2].toLowerCase() === 'kg' ? 1000 : 1);
    return positive(grams) ? grams : null;
}

export function productPortions(product) {
    const servingGrams = massInGrams(product.serving_size);
    const packageGrams = massInGrams(product.quantity);
    return {
        ...(servingGrams ? { servingGrams, servingLabel: `Porzioni (${product.serving_size})` } : {}),
        ...(packageGrams ? { packageGrams } : {})
    };
}

export function readPortionHistory(storage, userId) {
    if (!userId) return [];
    try {
        const data = JSON.parse(storage.getItem(`nutritrack_portions_v1:${userId}`) || '[]');
        return Array.isArray(data) ? data.filter(entry => entry?.food?.name && entry?.key && positive(entry.quantity)).slice(0, 30) : [];
    } catch { return []; }
}

export function rememberPortion(storage, userId, food, quantity, portion, customUnit) {
    if (!userId || !positive(quantity)) return false;
    try {
        const entry = { key: foodKey(food), food, quantity, portion, customUnit };
        const entries = readPortionHistory(storage, userId).filter(item => item.key !== entry.key);
        storage.setItem(`nutritrack_portions_v1:${userId}`, JSON.stringify([entry, ...entries].slice(0, 30)));
        return true;
    } catch { return false; }
}
