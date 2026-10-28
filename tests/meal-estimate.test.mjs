import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMealEstimate, estimateRow, estimateRange, estimateBreakdown, estimateLabel } from '../public/modules/mealEstimate.js';
import { editPortion, mealTemplate } from '../public/modules/diary.js';
import { mealNutrition } from '../public/modules/nutrition.js';
import { portionOptions } from '../public/modules/portions.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
test('grill uses cooked edible weights and sums individual meat and condiment nutrients', () => {
    const sausage = { ...estimateRow('sausage'), count: 2 };
    const ribs = { ...estimateRow('ribs'), count: 3 };
    const oil = { ...estimateRow('oil'), count: 0.5 };
    const food = buildMealEstimate('grill', [sausage, ribs, oil]);
    assert.equal(food.quantity, 300); // 160 g + 135 g edible ribs, no bone + 5 g oil.
    near(mealNutrition(food).calories, 324 * 1.6 + 290 * 1.35 + 45);
    near(mealNutrition(food).fats, 26.1 * 1.6 + 21 * 1.35 + 5);
    assert.equal(food.estimate.margin, 0.3);
    assert.equal(estimateLabel(food), 'Stima in pezzi');
    assert.equal(estimateLabel({ estimated: true }), 'Stima da foto');
    assert.equal(portionOptions(food)[1].source, 'Stima in pezzi');
});
test('sushi distinguishes pieces, rich rolls and sashimi; fractional counts and user overrides scale', () => {
    const rows = [{ ...estimateRow('nigiri'), count: 4 }, { ...estimateRow('rich-roll'), count: 8 }, { ...estimateRow('sashimi'), count: 2.5, grams: 16, calories: 180 }];
    const food = buildMealEstimate('sushi', rows);
    assert.equal(food.quantity, 480);
    near(mealNutrition(food).calories, 201.3 * 1.2 + 280 * 3.2 + 180 * 0.4);
    assert.equal(food.estimate.margin, 0.35);
    assert.match(estimateBreakdown(food), /2,5 fette/);
    assert.equal(rows[2].grams, 16);
});
test('copied and edited estimates preserve provenance and scale range and composition with the portion', () => {
    const food = buildMealEstimate('sushi', [{ ...estimateRow('nigiri'), count: 8 }]);
    const copied = mealTemplate({ ...food, id: 'old', jsDate: new Date(), pending: true });
    assert.deepEqual(copied.estimate, food.estimate);
    assert.equal(copied.id, undefined);
    const half = { ...copied, ...editPortion(copied, 0.5) };
    near(mealNutrition(half).calories, mealNutrition(food).calories / 2);
    assert.match(estimateBreakdown(half), /4 pezzi/);
    assert.equal(estimateRange(half), 'Intervallo indicativo: 157–326 kcal');
    const grams = { ...half, ...editPortion(half, 60, false) };
    assert.match(estimateBreakdown(grams), /2 pezzi/);
    assert.equal(estimateRange(grams), 'Intervallo indicativo: 79–163 kcal');
});
test('invalid and empty entries never produce a plausible-looking zero estimate', () => {
    assert.throws(() => buildMealEstimate('sushi', []));
    assert.throws(() => buildMealEstimate('unknown', [estimateRow('nigiri')]));
    for (const field of ['count', 'grams', 'calories', 'proteins', 'carbs', 'fats', 'fibers']) {
        for (const value of ['', -1, NaN, Infinity]) assert.throws(() => buildMealEstimate('sushi', [{ ...estimateRow('nigiri'), [field]: value }]));
    }
    for (const field of ['count', 'grams']) assert.throws(() => buildMealEstimate('grill', [{ ...estimateRow('sausage'), [field]: 0 }]));
    assert.throws(() => buildMealEstimate('grill', Array.from({length:31}, () => estimateRow('sausage'))));
});
