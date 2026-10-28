import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as portions from '../public/modules/portions.js';
import * as nutrition from '../public/modules/nutrition.js';
import * as estimates from '../public/modules/mealEstimate.js';
import * as diary from '../public/modules/diary.js';
import { createWriteTracker } from '../public/modules/sync.js';
import * as foodSearch from '../public/modules/foodSearch.js';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');

function harness({ food = null, quantity = 100, custom = false, failWrite = false } = {}) {
    const writes = [];
    const fields = new Map();
    const storage = new Map();
    const element = id => {
        if (!fields.has(id)) fields.set(id, { value: '', checked: false, innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, replaceChildren() {}, focus() {}, scrollIntoView() {} });
        return fields.get(id);
    };
    const context = vm.createContext({
        ...portions, ...estimates, ...nutrition, ...foodSearch, ...diary, createWriteTracker, console: { error() {} }, navigator: { onLine: true },
        window: { addEventListener() {} }, getTodayUTC: () => new Date('2026-10-20T12:00:00Z'),
        document: { getElementById: element, querySelectorAll: () => context.fixtureRows, querySelector: () => element('section-title') }, fixtureRows: [], fixtureFood: food, fixtureQuantity: quantity, fixtureCustom: custom,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        Timestamp: { now: () => 0, fromDate: value => value },
        collection: (...args) => args, query: (...args) => args, where: (...args) => args,
        doc: (...args) => args, documentId: () => '__name__',
        updateDoc: async (path, data) => writes.push({ path, data, updated: true }),
        getDocs: async () => ({ docs: [] }),
        setDoc: async (path, data) => { if (failWrite) throw Error('Offline'); writes.push({ path, data }); },
        addDoc: async (path, data) => { if (failWrite) throw Error('Offline'); writes.push({ path, data }); },
        getDayBounds: date => ({ start: date, end: date }), getMealTimestamp: () => new Date(),
        showToast() {}
    });
    vm.runInContext(source, context);
    vm.runInContext(`
        selectedFood = fixtureFood;
        userId = 'test-user';
        isCustomMealMode = fixtureCustom;
        portionPicker = {
            quantity: () => fixtureQuantity,
            metadata: () => ({ unitId: 'serving', label: 'Porzioni', amount: 1.5, gramsPerUnit: 250, source: 'Ricetta' }),
            customUnit: () => null
        };
        resetAddMealForm = () => {};
        renderRecentPortions = () => {};
    `, context);
    element('meal-type').value = '🍽️ Pranzo';
    element('custom-meal-name').value = 'Pasto personalizzato';
    for (const field of ['calories', 'proteins', 'carbs', 'fats']) element(`custom-meal-${field}`).value = '10';
    return { context, writes, element, storage, run: code => vm.runInContext(code, context) };
}

const recipe = { id: 'r1', name: 'Ricetta prova', isRecipe: true, servings: 4, totalWeight: 500, finalWeight: 1000, totalNutrition: { calories: 1200, proteins: 40, carbs: 160, fats: 44 } };

test('saving a recipe favorite stores normalized nutrients, amount and recipe identity', async () => {
    const app = harness({ food: recipe, quantity: 375 });
    await app.run('addToFavorites()');
    assert.equal(app.writes.length, 1);
    const saved = app.writes[0].data;
    assert.equal(saved.calories, 120);
    assert.equal(saved.quantity, 375);
    assert.equal(saved.recipeId, 'r1');
    assert.equal(saved.portion.amount, 1.5);
});

test('logging a fractional recipe stores correct nutrition without mutating the recipe or its name', async () => {
    const app = harness({ food: recipe, quantity: 375 });
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    const saved = app.writes[0].data;
    assert.equal(saved.calories * saved.quantity / 100, 450);
    assert.equal(saved.name, recipe.name);
    assert.equal(saved.recipeId, recipe.id);
    assert.equal(app.run('selectedFood.isRecipe'), true);
    assert.equal(app.storage.size, 1);
});

test('custom meals reject invalid quantities before any write, including saving as a food', async () => {
    for (const quantity of [-10, 0, NaN, Infinity]) {
        const app = harness({ quantity, custom: true });
        app.element('save-custom-meal-as-food').checked = true;
        await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.writes.length, 0);
    }
    const app = harness({ quantity: 80, custom: true });
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.writes[0].data.quantity, 80);
    assert.equal(app.writes[0].data.isCustom, true);
});

test('failed writes do not update portion memory', async () => {
    const app = harness({ food: recipe, quantity: 375, failWrite: true });
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.writes.length, 0);
    assert.equal(app.storage.size, 0);
});

test('changing food during a pending save cannot mix the saved portion and the new selection', async () => {
    const app = harness({ food: recipe, quantity: 375 });
    app.context.capturedWrites = app.writes;
    app.run(`setDoc = async (path, data) => {
        capturedWrites.push({path, data});
        selectedFood = { id: 'new-food', name: 'Nuova selezione' };
        fixtureQuantity = 50;
        portionPicker.metadata = () => ({ unitId: 'g', amount: 50, gramsPerUnit: 1 });
        return { docs: [] };
    };`);
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.writes[0].data.quantity, 375);
    assert.equal(app.writes[0].data.portion.amount, 1.5);
    const history = JSON.parse([...app.storage.values()][0]);
    assert.equal(history[0].food.id, recipe.id);
    assert.equal(app.run('selectedFood.id'), 'new-food');
});

test('using a recipe opens portion selection rather than immediately logging one portion', () => {
    const app = harness({ food: recipe });
    app.run('recipes = [fixtureFood]; selectMealFood = food => { globalThis.chosen = food; }; useRecipe("r1");');
    assert.equal(app.context.chosen.id, recipe.id);
    assert.equal(app.writes.length, 0);
});

test('an existing favorite can be updated with a different portion', async () => {
    const app = harness({ food: recipe, quantity: 375 });
    app.run('favoriteMeals = [{ id: "favorite-1", name: fixtureFood.name }];');
    await app.run('addToFavorites()');
    assert.equal(app.writes.length, 1);
    assert.equal(app.writes[0].updated, true);
    assert.equal(app.writes[0].data.quantity, 375);
    assert.equal(app.writes[0].data.calories, 120);
});

test('editing a meal weight replaces stale portion metadata and rejects invalid weights', async () => {
    const app = harness();
    app.run(`mealToEditId = 'meal-1'; allMeals = [{ id: 'meal-1', quantity: 60, portion: {unitId: 'custom', amount: 2, gramsPerUnit: 30} }];`);
    app.element('edit-meal-name-input').value = 'Pane';
    app.element('edit-meal-type').value = '🍽️ Pranzo';
    app.element('edit-meal-quantity').value = '-1';
    await app.run('saveMealChanges()');
    assert.equal(app.writes.length, 0);
    app.element('edit-meal-quantity').value = '90';
    await app.run('saveMealChanges()');
    assert.equal(app.writes[0].data.quantity, 90);
    assert.equal(app.writes[0].data.portion.unitId, 'g');
    assert.equal(app.writes[0].data.portion.amount, 90);
});

test('recipe cards escape names coming from the shared food database', () => {
    const app = harness();
    app.run(`recipes = [{ id: 'r1', name: '<img src=x onerror=alert(1)>', servings: 1, ingredients: [{ name: '<script>x</script>', quantity: 100 }] }]; renderRecipes();`);
    const html = app.element('saved-recipes').innerHTML;
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('saving an edited recipe updates it once and never creates a duplicate', async () => {
    const app = harness();
    const row = (name, quantity, foodId) => ({ querySelector: selector => selector === '.recipe-ingredient-name' ? { value: name, dataset: { foodId } } : { value: String(quantity) } });
    app.context.fixtureRows = [row('Pasta', 200, 'f1'), row('Olio', 10, 'f2')];
    app.run(`
        getDocs = async () => ({ forEach: fn => [
            { id: 'f1', data: () => ({ calories: 350, proteins: 12, carbs: 70, fats: 1.5, fibers: 3 }) },
            { id: 'f2', data: () => ({ calories: 900, proteins: 0, carbs: 0, fats: 100 }) }
        ].forEach(fn) });
        recipeToEditId = 'r1';
        exitRecipeEditMode = () => { recipeToEditId = null; };
    `);
    app.element('recipe-name').value = 'Pasta in bianco';
    app.element('recipe-servings').value = '2';
    app.element('recipe-final-weight').value = '';
    await app.run('saveRecipe()');
    assert.equal(app.writes.length, 1);
    assert.equal(app.writes[0].updated, true);
    assert.equal(app.writes[0].path.at(-1), 'r1');
    assert.equal(app.writes[0].data.totalNutrition.calories, 790);
    assert.equal(app.writes[0].data.totalWeight, 210);
    assert.equal(app.run('recipeToEditId'), null);
});

test('a meal can be registered offline without waiting for a server acknowledgement or a read', async () => {
    const app = harness({ food: recipe, quantity: 375 });
    app.run(`isOnline = false; getDocs = () => { throw Error('Must not read'); }; setDoc = (path, data) => { offlinePayload = data; return new Promise(() => {}); };`);
    await app.run('addMeal(true)');
    assert.equal(app.run('offlinePayload.quantity'), 375);
    assert.equal(app.element('add-meal-btn').disabled, false);
    assert.equal(app.run('syncCounts.pending'), 1);
});

test('editing original portions multiplies the amount rather than treating it as grams', async () => {
    const app = harness();
    app.run(`mealToEditId = 'm'; allMeals = [{ id: 'm', quantity: 60, portion: { unitId: 'custom', label: 'Fette', amount: 2, gramsPerUnit: 30 } }];`);
    app.element('edit-meal-name-input').value = 'Pane';
    app.element('edit-meal-type').value = '🌅 Colazione';
    app.element('edit-meal-unit').value = 'original';
    app.element('edit-meal-quantity').value = '3';
    await app.run('saveMealChanges()');
    assert.equal(app.writes[0].data.quantity, 90);
    assert.equal(app.writes[0].data.portion.amount, 3);
    assert.equal(app.writes[0].data.portion.label, 'Fette');
});

test('historical queries follow the selected week, remove deleted meals and ignore late results', () => {
    const app = harness();
    app.run(`
        collection = (_, path) => path;
        onSnapshot = (request, options, callback) => { lastRequest = request; lastSnapshot = callback; return () => {}; };
        renderHistoryStatus = renderSelectedDayMeals = renderSyncStatus = () => {};
        selectedDate = new Date('2025-01-02T12:00:00Z'); listenToMeals();
        oldCallback = lastSnapshot;
        lastSnapshot({ docs: [{ id: 'historical', data: () => ({ name: 'Pane', quantity: 100, calories: 250, date: { toDate: () => new Date('2025-01-02T12:00:00Z') } }), metadata: { hasPendingWrites: false } }], metadata: { fromCache: false, hasPendingWrites: false } });
    `);
    assert.equal(app.run('lastRequest[1][2].toISOString()'), '2024-12-27T12:00:00.000Z');
    assert.equal(app.run(`dailyTotalsCache['2025-01-02'].calories`), 250);
    app.run(`lastSnapshot({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } });`);
    assert.equal(app.run(`dailyTotalsCache['2025-01-02']`), undefined);
    app.run(`selectedDate = new Date('2025-06-20T12:00:00Z'); listenToMeals(); oldCallback({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } });`);
    assert.equal(app.run(`dayLoadStates['2025-06-20']`), 'loading');
});

test('piece estimates retain their composition and range in diary writes and favorites', async () => {
    const food = estimates.buildMealEstimate('sushi', [{ ...estimates.estimateRow('nigiri'), count: 6 }]);
    const app = harness({ food, quantity: food.quantity });
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(app.writes[0].data.estimate, food.estimate);
    assert.equal(app.writes[0].data.estimated, true);
    await app.run('addToFavorites()');
    assert.deepEqual(app.writes[1].data.estimate, food.estimate);
});

test('description estimates keep provenance when saved to diary and favorites', async () => {
    const food = { name: 'Polpette', calories: 220, proteins: 20, carbs: 8, fats: 12, fibers: 1, estimated: true,
        aiEstimate: { model: 'gemini-3.8-flash', assumptions: ['Cotte al forno'], notes: '', input: { name: 'Polpette' }, edited: false } };
    const app = harness({ food, quantity: 180 });
    await app.run('addMeal()');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(app.writes[0].data.aiEstimate, food.aiEstimate);
    assert.equal(app.writes[0].data.calories, 220);
    assert.equal(app.writes[0].data.quantity, 180);
    await app.run('addToFavorites()');
    assert.deepEqual(app.writes[1].data.aiEstimate, food.aiEstimate);
});

test('editing ingredients updates the existing meal only when the edit is saved, preserving its date', async () => {
    const food = estimates.buildMealEstimate('grill', [estimates.estimateRow('sausage')]);
    const changed = estimates.buildMealEstimate('grill', [{...estimates.estimateRow('sausage'), count: 2}]);
    const app = harness();
    app.context.fixtureOriginal = food;
    app.context.fixtureChanged = changed;
    app.run("allMeals = [{...fixtureOriginal, id:'meal1', jsDate:new Date('2026-09-10T12:00:00Z')}]; mealToEditId = 'meal1'; editedMealEstimate = fixtureChanged;");
    assert.equal(app.writes.length, 0);
    app.element('edit-meal-quantity').value = '1';
    app.element('edit-meal-unit').value = 'original';
    app.element('edit-meal-name-input').value = 'La mia grigliata';
    app.element('edit-meal-type').value = '🌙 Cena';
    app.context.getMealTimestamp = (_type, date) => date;
    await app.run('saveMealChanges()');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.writes.length, 1);
    assert.equal(app.writes[0].updated, true);
    assert.equal(app.writes[0].data.quantity, 160);
    assert.equal(app.writes[0].data.name, 'La mia grigliata');
    assert.deepEqual(app.writes[0].data.estimate, changed.estimate);
    assert.equal(app.writes[0].data.date.toISOString(), '2026-09-10T12:00:00.000Z');
});
