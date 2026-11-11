import { NUTRIENT_KEYS, emptyTotals, addTotals, mealNutrition } from './nutrition.js';

// Editable example, not a nutritional recommendation or an inferred intake.
export const defaultDayPreset = Object.freeze({ calories: 3000, proteins: 120, carbs: 360, fats: 120, fibers: 25 });
export const isDayPreset = meal => meal?.dayPreset?.kind === 'free-day';
export const findDayPreset = meals => meals.find(isDayPreset);

export function buildDayPreset(values) {
    const totals = {};
    for (const key of NUTRIENT_KEYS) {
        const value = values?.[key];
        if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || (key === 'calories' && Number(value) === 0)) {
            throw new Error('Inserisci calorie maggiori di zero e valori validi per tutti i nutrienti (anche zero).');
        }
        totals[key] = Number(value);
    }
    return {
        name: 'Giorno sgarro', ...totals, quantity: 100, type: 'Giornata',
        estimated: true, dayPreset: { version: 1, kind: 'free-day' },
        portion: { unitId: 'serving', label: 'Giornata', amount: 1, gramsPerUnit: 100, source: 'Stima giornaliera' }
    };
}

export function dayNutrition(meals) {
    const preset = findDayPreset(meals);
    return preset ? mealNutrition(preset) : meals.reduce((totals, meal) => addTotals(totals, mealNutrition(meal)), emptyTotals());
}

const storageKey = owner => `nutritrack:day-preset:${owner}`;
export function readDayPreset(storage, owner) {
    try {
        const saved = JSON.parse(storage.getItem(storageKey(owner)));
        return mealNutrition(buildDayPreset(saved));
    } catch { return { ...defaultDayPreset }; }
}
export function rememberDayPreset(storage, owner, values) {
    try { storage.setItem(storageKey(owner), JSON.stringify(mealNutrition(buildDayPreset(values)))); }
    catch { /* Unavailable storage must not prevent diary writes. */ }
}
