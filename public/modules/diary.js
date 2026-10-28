import { positive, nutritionPer100g } from './portions.js?v=20261025';

export const dayKey = date => date.toISOString().slice(0, 10);
export function weekDates(date) {
    return Array.from({ length: 7 }, (_, i) => {
        const day = new Date(date);
        day.setUTCDate(day.getUTCDate() - 6 + i);
        return day;
    });
}
export function calorieSeries(totals, date) {
    return weekDates(date).map(day => ({ date: day, value: totals[dayKey(day)] ? Math.round(totals[dayKey(day)].calories) : null }));
}
export function editPortion(meal, amount, useOriginal = true) {
    const saved = meal.portion;
    const original = useOriginal && saved && positive(saved.gramsPerUnit);
    const grams = original ? Number(saved.gramsPerUnit) : 1;
    if (!positive(amount) || !positive(Number(amount) * grams)) throw new Error('Inserisci una quantità maggiore di zero.');
    return {
        quantity: Number(amount) * grams,
        portion: original ? { ...saved, amount: Number(amount) }
            : { unitId: 'g', label: 'Grammi', amount: Number(amount), gramsPerUnit: 1, source: 'Peso inserito', ingredientWeight: Boolean(saved?.ingredientWeight) }
    };
}
// Whitelist: never copy document IDs, dates or local snapshot metadata into a new meal.
export function mealTemplate(meal) {
    if (!meal.name || !positive(meal.quantity)) throw new Error('Pasto incompleto.');
    return {
        name: meal.name, ...nutritionPer100g({ ...meal, isRecipe: false }), quantity: Number(meal.quantity),
        portion: meal.portion || null, customUnit: meal.customUnit || null,
        foodId: meal.foodId || null, recipeId: meal.recipeId || null,
        estimated: Boolean(meal.estimated), estimate: meal.estimate || null, aiEstimate: meal.aiEstimate || null, isCustom: Boolean(meal.isCustom)
    };
}
