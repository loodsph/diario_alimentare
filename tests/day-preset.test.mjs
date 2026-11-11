import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayPreset, defaultDayPreset, dayNutrition, readDayPreset, rememberDayPreset } from '../public/modules/dayPreset.js';
import { mealTemplate } from '../public/modules/diary.js';

test('daily estimate replaces the meal sum, even when meals are added later; removing it restores meals', () => {
    const breakfast = { quantity: 200, calories: 150, proteins: 10, carbs: 20, fats: 5, fibers: 2 };
    const preset = buildDayPreset(defaultDayPreset);
    assert.deepEqual(dayNutrition([breakfast, preset, breakfast]), defaultDayPreset);
    assert.deepEqual(dayNutrition([preset, breakfast]), defaultDayPreset);
    assert.equal(dayNutrition([breakfast, breakfast]).calories, 600);
    assert.equal(dayNutrition([]).calories, 0);
    const restored = mealTemplate({ ...preset, id: 'old', date: 'old' });
    assert.deepEqual(dayNutrition([breakfast, restored]), defaultDayPreset);
    assert.equal(restored.id, undefined);
});

test('all daily nutrient fields are validated; zero macros and fractional values are allowed', () => {
    for (const key of Object.keys(defaultDayPreset)) {
        for (const value of ['', ' ', -1, NaN, Infinity, null, undefined, false, []]) {
            assert.throws(() => buildDayPreset({ ...defaultDayPreset, [key]: value }));
        }
    }
    assert.throws(() => buildDayPreset({ ...defaultDayPreset, calories: 0 }));
    assert.equal(buildDayPreset({ ...defaultDayPreset, proteins: '0', carbs: '125.5' }).carbs, 125.5);
});

test('remembered preset values are isolated by account and tolerate unavailable or corrupt storage', () => {
    const memory = new Map();
    const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
    const values = { ...defaultDayPreset, calories: 2700 };
    rememberDayPreset(storage, 'alice', values);
    assert.deepEqual(readDayPreset(storage, 'alice'), values);
    assert.deepEqual(readDayPreset(storage, 'bob'), defaultDayPreset);
    for (const key of memory.keys()) memory.set(key, '{bad');
    assert.deepEqual(readDayPreset(storage, 'alice'), defaultDayPreset);
    const unavailable = { getItem() { throw Error(); }, setItem() { throw Error(); } };
    assert.doesNotThrow(() => rememberDayPreset(unavailable, 'alice', values));
    assert.deepEqual(readDayPreset(unavailable, 'alice'), defaultDayPreset);
});
