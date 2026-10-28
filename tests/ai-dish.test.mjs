import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDishInput, buildDishPrompt, parseDishResponse, analyzeDish, dishToFood } from '../public/modules/aiDishAnalysis.js';
import { mealTemplate } from '../public/modules/diary.js';
import { estimateLabel } from '../public/modules/mealEstimate.js';

const input = { name: 'Polpette di carne', ingredients: [{ name: 'Manzo', amount: '500', unit: 'g', state: 'Crudo' }], cooking: 'Al forno', finalWeight: '650', fat: 'Olio di oliva', fatAmount: '10', fatUnit: 'ml' };
const result = { name: 'Polpette al forno', values: { calories: 220, proteins: 20, carbs: 8, fats: 12, fibers: 1 }, assumptions: ['Ricetta con manzo e pane; peso finale 650 g.'], notes: 'Quantità di pane ipotizzata.' };

test('unknown ingredients, weights and condiments stay unknown rather than becoming zero', () => {
    const data = normalizeDishInput({ name: 'Polpette', ingredients: [{ name: '', amount: '' }] });
    assert.deepEqual(data.ingredients, []);
    assert.equal(data.fatAmount, null);
    assert.equal(data.finalWeight, null);
    assert.equal(data.fat, 'Non so');
    assert.equal(data.completeness, 'Conosco solo alcuni ingredienti');
});
test('prompt preserves ingredient state, units, whole-recipe weight and quantitative details', () => {
    const prompt = buildDishPrompt(input);
    const data = JSON.parse(prompt.match(/<dati_piatto>(\{.*\})<\/dati_piatto>/s)[1]);
    assert.equal(data.ingredients[0].amount, 500);
    assert.equal(data.ingredients[0].state, 'Crudo');
    assert.equal(data.fatUnit, 'ml');
    assert.equal(data.fatAmount, 10);
    assert.equal(data.finalWeight, 650);
    assert.match(prompt, /TUTTA la stessa preparazione/);
    assert.match(prompt, /UNA SOLA VOLTA/);
});
test('invalid amounts and incomplete rows are rejected before requests', () => {
    for (const value of [-2, 0, NaN, Infinity, 'abc']) {
        assert.throws(() => normalizeDishInput({ ...input, finalWeight: value }));
    }
    assert.throws(() => normalizeDishInput({ name: '' }));
    assert.throws(() => normalizeDishInput({ ...input, ingredients: [{ name: '', amount: 10 }] }));
    assert.equal(normalizeDishInput({ ...input, fat: 'Nessuno', fatAmount: 10 }).fatAmount, null);
    assert.equal(normalizeDishInput({ ...input, fat: 'Già indicato negli ingredienti', fatAmount: 10 }).fatAmount, null);
});
test('rejects missing nutrients, implausible values and missing assumptions', () => {
    assert.deepEqual(parseDishResponse(JSON.stringify(result)), result);
    for (const values of [{ ...result.values, calories: null }, { ...result.values, proteins: '' }, { ...result.values, fats: -1 }, { ...result.values, calories: 1500 }, { calories: 900, proteins: 80, carbs: 80, fats: 80, fibers: 0 }]) {
        assert.throws(() => parseDishResponse(JSON.stringify({ ...result, values })));
    }
    assert.throws(() => parseDishResponse('{}'));
    assert.throws(() => parseDishResponse('not json'));
    assert.throws(() => parseDishResponse(JSON.stringify({ ...result, assumptions: [] })));
});
test('corrected values remain per 100 g and provenance survives meal copies', () => {
    const food = dishToFood(result, input, { ...result.values, fats: 11 });
    assert.equal(food.aiEstimate.edited, true);
    assert.equal(food.fats, 11);
    assert.equal(food.quantity, undefined);
    const copied = mealTemplate({ ...food, quantity: 250 });
    assert.equal(copied.calories * copied.quantity / 100, 550);
    assert.deepEqual(copied.aiEstimate, food.aiEstimate);
    assert.equal(estimateLabel(copied), 'Stima da descrizione');
    assert.equal(estimateLabel({ estimated: true }), 'Stima da foto');
});
test('Gemini uses structured JSON, a header key, cancellation and no search tools', async t => {
    const signal = new AbortController().signal;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.match(url, /gemini-3\.8-flash:generateContent$/);
        assert.ok(!url.includes('test-key'));
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        assert.equal(options.signal, signal);
        const body = JSON.parse(options.body);
        assert.equal(body.tools, undefined);
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
        assert.ok(body.generationConfig.responseJsonSchema);
        return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'ignore' }, { text: JSON.stringify(result) }] } }] }) };
    });
    assert.deepEqual(await analyzeDish('test-key', input, { signal }), result);
});
test('quota, unavailable model and incomplete generation produce actionable errors', async t => {
    const fetch = t.mock.method(globalThis, 'fetch');
    fetch.mock.mockImplementation(async () => ({ ok: false, status: 429 }));
    await assert.rejects(analyzeDish('test-key', input), /Quota/);
    fetch.mock.mockImplementation(async () => ({ ok: false, status: 404 }));
    await assert.rejects(analyzeDish('test-key', input), /non è disponibile/);
    fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) }));
    await assert.rejects(analyzeDish('test-key', input), /non ha completato/);
    await assert.rejects(analyzeDish('', input), /chiave/);
});
