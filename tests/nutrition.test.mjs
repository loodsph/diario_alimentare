import test from 'node:test';
import assert from 'node:assert/strict';
import { mealNutrition, computeRecipeNutrition, findMissingIngredients, groupNutrientDetails } from '../public/modules/nutrition.js';
import { searchTokens, normalizeQuery, queryToken, sortResults, matchesSearch, buildUsageStats, usageBoost } from '../public/modules/foodSearch.js';

test('meal nutrition scales per-100g values and falls back to CREA field names', () => {
    assert.deepEqual(mealNutrition({ quantity: 150, calories: 200, proteins: 10, carbs: 20, fats: 4, fibers: 2 }),
        { calories: 300, proteins: 15, carbs: 30, fats: 6, fibers: 3 });
    const crea = mealNutrition({ quantity: 50, energia_kcal: 100, proteine_g: 8, carboidrati_disponibili_g: '12', lipidi_g: null, fibra_totale_g: 'x' });
    assert.deepEqual(crea, { calories: 50, proteins: 4, carbs: 6, fats: 0, fibers: 0 });
    assert.equal(mealNutrition({ calories: 100 }).calories, 0);
});

test('recipe totals ignore ingredients missing from the database and report them', () => {
    const foods = new Map([['a', { calories: 100, proteins: 10 }]]);
    const ingredients = [{ name: 'A', quantity: 250, foodId: 'a' }, { name: 'B', quantity: 50, foodId: 'b' }, { name: 'C', quantity: 10 }];
    const { totalNutrition, totalWeight } = computeRecipeNutrition(ingredients, foods);
    assert.equal(totalNutrition.calories, 250);
    assert.equal(totalNutrition.proteins, 25);
    assert.equal(totalWeight, 250);
    assert.deepEqual(findMissingIngredients(ingredients, foods).map(ing => ing.name), ['B', 'C']);
});

test('nutrient details are grouped, ordered and skip zero or non-numeric fields', () => {
    const groups = groupNutrientDetails({ name: 'Mela', fats: 0.1, calories: 52, ferro_mg: 0.1, vitamina_c_mg: 4.6, zero: 0, note: 'x', energia_kj: 218, polifenoli: 1 });
    assert.deepEqual(groups.map(group => group.title), ['Macronutrienti Principali', 'Minerali', 'Vitamine', 'Altri Nutrienti']);
    assert.deepEqual(groups[0].items.map(item => item.key), ['calories', 'fats']);
    assert.equal(groups[3].items[0].key, 'polifenoli');
});

test('search tokens, matching and ranking', () => {
    assert.deepEqual(searchTokens('Pane (integrale), tostato/Toast'), ['pane', 'integrale', 'tostato', 'toast']);
    const items = [
        { name: 'Pane integrale', name_lowercase: 'pane integrale', search_tokens: ['pane', 'integrale'] },
        { name: 'Grissini al pane', name_lowercase: 'grissini al pane', search_tokens: ['grissini', 'al', 'pane'] },
        { name: 'Pane', name_lowercase: 'pane', search_tokens: ['pane'] },
        { name: 'Panettone', name_lowercase: 'panettone', search_tokens: ['panettone'] }
    ];
    assert.deepEqual(sortResults([...items], 'pane').map(item => item.name), ['Pane', 'Pane integrale', 'Panettone', 'Grissini al pane']);
    assert.ok(matchesSearch(items[1], 'issini'));
    assert.ok(!matchesSearch(items[3], 'riso'));
});

test('multi-word search requires every word and picks a complete word for Firestore', () => {
    assert.equal(normalizeQuery('  Pasta   Integrale '), 'pasta integrale');
    assert.equal(queryToken('pasta'), 'pasta');
    assert.equal(queryToken('pasta di semola integr'), 'semola'); // l'ultima parola è incompleta
    const items = [
        { name: 'Pasta di semola integrale', search_tokens: ['pasta', 'di', 'semola', 'integrale'] },
        { name: 'Pasta di semola', search_tokens: ['pasta', 'di', 'semola'] },
        { name: 'Petto di pollo', search_tokens: ['petto', 'di', 'pollo'] },
        { name: 'Pollo intero', search_tokens: ['pollo', 'intero'] }
    ];
    assert.deepEqual(items.filter(item => matchesSearch(item, 'pasta integr')).map(item => item.name), ['Pasta di semola integrale']);
    assert.deepEqual(items.filter(item => matchesSearch(item, 'pollo petto')).map(item => item.name), ['Petto di pollo']);
    assert.ok(!matchesSearch(items[0], '   '));
});

test('frequently and recently used foods rank first among relevant results', () => {
    const now = new Date('2026-10-24T12:00:00Z').getTime();
    const daysAgo = days => new Date(now - days * 24 * 60 * 60 * 1000);
    const meals = [
        { name: 'Latte parzialmente scremato', foodId: 'latte-ps', jsDate: daysAgo(1) },
        { name: 'Latte parzialmente scremato', foodId: 'latte-ps', jsDate: daysAgo(2) },
        { name: 'Yogurt al latte intero', jsDate: daysAgo(40) } // pasto vecchio senza foodId
    ];
    const usage = buildUsageStats(meals);
    const items = [
        { id: 'latte', name: 'Latte' },
        { id: 'latte-ps', name: 'Latte parzialmente scremato' },
        { id: 'yogurt', name: 'Yogurt al latte intero' },
        { id: 'pane', name: 'Pane' }
    ];
    assert.equal(usageBoost(items[3], usage, now), 0);
    assert.equal(usageBoost(items[2], usage, now), 2); // trovato per nome, troppo vecchio per la recenza
    assert.deepEqual(sortResults([...items], 'latte', usage, now).map(item => item.name),
        ['Latte parzialmente scremato', 'Latte', 'Yogurt al latte intero', 'Pane']);
});
