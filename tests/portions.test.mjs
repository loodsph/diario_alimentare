import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionPer100g, portionOptions, quantityInGrams, productPortions, foodKey, readPortionHistory, rememberPortion } from '../public/modules/portions.js';
import { parseResponse } from '../public/modules/aiPhotoAnalysis.js';

const recipe = { id: 'r1', name: 'Ricetta', isRecipe: true, servings: 4, totalWeight: 500, totalNutrition: { calories: 1200, proteins: 40, carbs: 160, fats: 44 } };

test('recipe fractions conserve nutrients with and without a final cooked weight', () => {
    for (const food of [recipe, { ...recipe, finalWeight: 1000 }]) {
        const units = portionOptions(food);
        const per100 = nutritionPer100g(food);
        const grams = quantityInGrams(1.5, units.find(unit => unit.id === 'serving'));
        assert.equal(grams * per100.calories / 100, 450);
        const quarter = quantityInGrams(.25, units.find(unit => unit.id === 'recipe'));
        assert.equal(quarter * per100.calories / 100, 300);
    }
});

test('ordinary foods do not invent a serving; custom slices and packages convert correctly', () => {
    assert.equal(portionOptions({ name: 'Pane' }).length, 1);
    const units = portionOptions({ packageGrams: 250 }, { label: 'fetta', grams: 30 });
    assert.equal(quantityInGrams(2, units.find(unit => unit.id === 'custom')), 60);
    assert.equal(quantityInGrams(.5, units.find(unit => unit.id === 'package')), 125);
    for (const amount of ['', -10, 0, Infinity, NaN]) assert.ok(Number.isNaN(quantityInGrams(amount, units[0])));
});

test('barcode quantities use explicit masses and never assume a density', () => {
    assert.deepEqual(productPortions({ quantity: '0,5 kg', serving_size: '125 g' }),
        { packageGrams: 500, servingGrams: 125, servingLabel: 'Porzioni (125 g)' });
    assert.deepEqual(productPortions({ quantity: '500 ml', serving_size: '1 cucchiaio' }), {});
    assert.deepEqual(productPortions({ quantity: '2 x 125 g' }), {});
});

test('portion memory is isolated by account and survives reload without duplicates', () => {
    const map = new Map();
    const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
    const food = { id: 'bread', name: 'Pane', calories: 200 };
    const portion = { unitId: 'custom', label: 'fetta', amount: 2, gramsPerUnit: 30 };
    assert.equal(rememberPortion(storage, 'alice', food, 60, portion, { label: 'fetta', grams: 30 }), true);
    assert.equal(readPortionHistory(storage, 'bob').length, 0);
    assert.equal(readPortionHistory(storage, null).length, 0);
    assert.equal(readPortionHistory(storage, 'alice')[0].portion.amount, 2);
    rememberPortion(storage, 'alice', food, 90, { ...portion, amount: 3 }, null);
    assert.equal(readPortionHistory(storage, 'alice').length, 1);
    assert.equal(readPortionHistory(storage, 'alice')[0].quantity, 90);
    assert.equal(foodKey(recipe), foodKey({ recipeId: 'r1', name: 'Renamed' }));
});

test('storage failures do not prevent logging a meal', () => {
    const storage = { getItem() { throw Error('Denied'); }, setItem() { throw Error('Full'); } };
    assert.deepEqual(readPortionHistory(storage, 'a'), []);
    assert.equal(rememberPortion(storage, 'a', { name: 'Pane' }, 30, null, null), false);
});

test('incomplete recipes cannot produce infinite or zeroed favorite nutrition', () => {
    assert.throws(() => nutritionPer100g({ ...recipe, totalWeight: 0 }));
    assert.throws(() => nutritionPer100g({ ...recipe, servings: 0 }));
});

test('photo responses accept numeric strings and reject missing, negative and nonnumeric nutrients', () => {
    const response = { alimento: 'Piatto', quantita_stimata_g: '250', valori_per_100g: { calorie: '150', proteine: 5, carboidrati: 20, grassi: 4 } };
    const parsed = parseResponse('```json\n' + JSON.stringify(response) + '\n```');
    assert.equal(parsed.quantita_stimata_g, 250);
    assert.equal(parsed.valori_per_100g.calorie, 150);
    assert.equal(parsed.valori_per_100g.fibre, 0);
    for (const value of [-1, null, 'NaN', '', true]) {
        assert.throws(() => parseResponse(JSON.stringify({ ...response, valori_per_100g: { ...response.valori_per_100g, calorie: value } })));
    }
    assert.throws(() => parseResponse('{}'));
    assert.throws(() => parseResponse(JSON.stringify({ ...response, quantita_stimata_g: 0 })));
});
