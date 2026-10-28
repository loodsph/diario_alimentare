import test from 'node:test';
import assert from 'node:assert/strict';
import { editPortion, mealTemplate, calorieSeries, weekDates, dayKey } from '../public/modules/diary.js';
import { createWriteTracker } from '../public/modules/sync.js';
import { fitImage } from '../public/modules/photo.js';

test('editing slices and recipe fractions preserves the original units and nutritional basis', () => {
    const bread = { quantity: 60, calories: 250, portion: { unitId: 'custom', label: 'Fette', amount: 2, gramsPerUnit: 30 } };
    const edited = editPortion(bread, 3);
    assert.equal(edited.quantity, 90);
    assert.equal(edited.portion.label, 'Fette');
    assert.equal(edited.portion.amount, 3);
    assert.equal(bread.quantity, 60);
    const recipe = { quantity: 100, portion: { unitId: 'recipe', label: 'Ricetta intera', amount: 0.25, gramsPerUnit: 400, ingredientWeight: true } };
    assert.deepEqual(editPortion(recipe, 0.5), { quantity: 200, portion: { ...recipe.portion, amount: 0.5 } });
    assert.equal(editPortion(recipe, 120, false).portion.ingredientWeight, true);
    for (const amount of [0, -1, NaN, Infinity]) assert.throws(() => editPortion(bread, amount));
});

test('copying a meal preserves nutrient estimates without copying identity, date or pending status', () => {
    const source = { id: 'm1', date: 'old', pending: true, type: 'Cena', name: 'Pane', quantity: 90, calories: 250, proteins: 10, estimated: true, foodId: 'bread', portion: { unitId: 'custom', amount: 3, gramsPerUnit: 30 } };
    const copied = mealTemplate(source);
    assert.equal(copied.calories * copied.quantity / 100, 225);
    assert.equal(copied.estimated, true);
    assert.equal(copied.foodId, 'bread');
    for (const key of ['id', 'date', 'pending', 'type']) assert.equal(Object.hasOwn(copied, key), false);
});

test('charts follow the selected historical week and distinguish missing data from zero', () => {
    const date = new Date('2025-01-02T12:00:00Z');
    const series = calorieSeries({ '2024-12-30': { calories: 0 }, '2025-01-02': { calories: 612.2 } }, date);
    assert.equal(dayKey(series[0].date), '2024-12-27');
    assert.equal(dayKey(series.at(-1).date), '2025-01-02');
    assert.equal(series[0].value, null);
    assert.equal(series[3].value, 0);
    assert.equal(series.at(-1).value, 612);
    assert.equal(dayKey(date), '2025-01-02');
    assert.equal(weekDates(new Date('2026-03-30T12:00:00Z')).length, 7);
});

test('writes remain pending while offline and settle when the server acknowledges them', async () => {
    let acknowledge;
    let state;
    let remembered = false;
    const tracker = createWriteTracker(value => { state = value; }, () => assert.fail('Unexpected failure'));
    const done = tracker.submit(() => new Promise(resolve => { acknowledge = resolve; }), { onSynced: () => { remembered = true; } });
    await Promise.resolve();
    assert.equal(state.pending, 1);
    assert.equal(remembered, false);
    acknowledge(); await done;
    assert.equal(state.pending, 0);
    assert.equal(remembered, true);
});

test('failed writes can be retried and old failures cannot overwrite a newer edit or undo', async () => {
    let state, rejectOld;
    let attempts = 0;
    const tracker = createWriteTracker(value => { state = value; }, () => {});
    await tracker.submit(() => { if (++attempts === 1) throw Error('Denied'); }, { key: 'm1' });
    assert.equal(state.failed, 1);
    tracker.retry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.failed, 0);
    assert.equal(attempts, 2);
    const old = tracker.submit(() => new Promise((_, reject) => { rejectOld = reject; }), { key: 'm1' });
    await Promise.resolve();
    await tracker.submit(() => Promise.resolve(), { key: 'm1' });
    rejectOld(Error('Late rejection')); await old;
    assert.equal(state.failed, 0);
});

test('account changes isolate pending write callbacks and failures', async () => {
    let reject, state, called = false;
    const tracker = createWriteTracker(value => { state = value; }, () => { called = true; });
    const task = tracker.submit(() => new Promise((_, fail) => { reject = fail; }));
    await Promise.resolve(); tracker.reset(); reject(Error('Old account')); await task;
    assert.equal(called, false);
    assert.deepEqual(state, { pending: 0, failed: 0 });
});

test('photo resizing preserves aspect ratio, limits both orientations and never upscales', () => {
    assert.deepEqual(fitImage(4032, 3024), { width: 1600, height: 1200 });
    assert.deepEqual(fitImage(3024, 4032), { width: 1200, height: 1600 });
    assert.deepEqual(fitImage(320, 240), { width: 320, height: 240 });
    assert.throws(() => fitImage(0, 400));
});
