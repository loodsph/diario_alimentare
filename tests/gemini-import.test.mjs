import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_INSTRUCTIONS, parseGeminiText, importedPortionToFood } from '../public/modules/geminiImport.js';
import { portionDescription, portionOptions, foodKey, rememberPortion, readPortionHistory } from '../public/modules/portions.js';
import { mealNutrition } from '../public/modules/nutrition.js';
import { mealTemplate, editPortion } from '../public/modules/diary.js';
import { estimateLabel } from '../public/modules/mealEstimate.js';

const raw = 'Nome: Pollo con riso\nP: 25\nC: 12\nG: 2\nkcal: 166\nF: 1\nNote: Porzione mangiata, olio incluso.';

test('the four-line user format accepts spacing, decimal commas, units and kal', () => {
    const parsed = parseGeminiText('```text\n p : 25,5 g\r\n C:12\r\nG: 2 g\r\nkal: 112 kcal\n```');
    assert.deepEqual(parsed.values, { calories: 112, proteins: 25.5, carbs: 12, fats: 2, fibers: null });
    assert.equal(parsed.name, '');
    assert.deepEqual(parseGeminiText('P:0\nC:0\nG:0\nkcal:0\nF:0').values, { calories: 0, proteins: 0, carbs: 0, fats: 0, fibers: 0 });
});

test('rejects missing, duplicated, ambiguous, negative and malformed nutrients', () => {
    for (const invalid of ['', 'P:25\nC:12\nG:2', raw + '\nP: 10', raw + '\nkal: 100', raw + '\nPeso: 250', raw + '\nconstructor: 1', raw + '\n' + raw]) {
        assert.throws(() => parseGeminiText(invalid));
    }
    for (const value of ['', '-1', 'NaN', 'Infinity', '1e2', '12-20', '~25', '2.000,5', '25 mg', '25 kcal', '100001', '25 e 10']) {
        assert.throws(() => parseGeminiText(raw.replace('P: 25', `P: ${value}`)), value);
    }
    assert.throws(() => parseGeminiText(raw.replace('F: 1', 'F: sconosciute')));
    assert.throws(() => parseGeminiText('x'.repeat(6001)));
});

test('one eaten portion and fractions preserve totals without inventing a weight', () => {
    const parsed = parseGeminiText(raw);
    const food = importedPortionToFood(parsed, parsed.name);
    assert.equal(mealNutrition(food).calories, 166);
    assert.equal(mealNutrition(food).proteins, 25);
    const half = { ...food, ...editPortion(food, 0.5) };
    assert.equal(mealNutrition(half).calories, 83);
    assert.equal(mealNutrition(half).proteins, 12.5);
    assert.equal(portionDescription(half.portion), '0,5 × Porzione descritta');
    assert.equal(estimateLabel(half), 'Stima da Gemini');
    assert.deepEqual(portionOptions(food, { label: 'Fette', grams: 30 }).map(unit => unit.id), ['portion']);
    assert.throws(() => editPortion(food, 100, false), /non in grammi/);
    for (const amount of [0, -1, NaN, Infinity]) assert.throws(() => editPortion(food, amount));
    const copied = mealTemplate(half);
    assert.deepEqual(copied.importedEstimate, food.importedEstimate);
    assert.equal(copied.portion.weightUnknown, true);
    assert.equal(mealNutrition(copied).calories, 83);
});

test('corrections and missing fibre remain explicit, while existing estimates keep their labels', () => {
    const parsed = parseGeminiText(raw.replace('F: 1\n', ''));
    const food = importedPortionToFood(parsed, 'Pranzo', { ...parsed.values, calories: '180', proteins: '26,5' });
    assert.equal(food.fibers, 0);
    assert.equal(food.importedEstimate.fibersKnown, false);
    assert.equal(food.importedEstimate.edited, true);
    assert.equal(food.importedEstimate.originalValues.calories, 166);
    assert.equal(food.proteins, 26.5);
    assert.throws(() => importedPortionToFood(parsed, ''));
    assert.throws(() => importedPortionToFood(parsed, 'Pranzo', { ...parsed.values, calories: '' }));
    assert.equal(estimateLabel({ estimated: true }), 'Stima da foto');
    assert.equal(estimateLabel({ aiEstimate: {} }), 'Stima da descrizione');
});

test('portion memory cannot reuse gram amounts from a same-name ordinary food', () => {
    const parsed = parseGeminiText(raw);
    const food = importedPortionToFood(parsed, parsed.name);
    const ordinary = { name: food.name, calories: 166 };
    assert.notEqual(foodKey(food), foodKey(ordinary));
    assert.notEqual(foodKey(food), foodKey({ ...food, calories: 300 }));
    const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
    rememberPortion(storage, 'alice', food, 50, { ...food.portion, amount: 0.5 }, null);
    const recent = readPortionHistory(storage, 'alice')[0];
    assert.equal(recent.portion.weightUnknown, true);
    assert.equal(recent.food.importedEstimate.basis, 'portion');
    assert.equal(mealNutrition({ ...recent.food, quantity: recent.quantity }).calories, 83);
    assert.deepEqual(readPortionHistory(storage, 'bob'), []);
});

test('Gem instructions use the parser contract and always describe the eaten portion', () => {
    const example = GEMINI_INSTRUCTIONS.match(/Nome: Pollo con riso[\s\S]*?Note: [^\n]+/)[0];
    assert.equal(parseGeminiText(example).values.calories, 166);
    assert.match(GEMINI_INSTRUCTIONS, /mai per 100 g/);
    assert.match(GEMINI_INSTRUCTIONS, /attendi la risposta/);
});
