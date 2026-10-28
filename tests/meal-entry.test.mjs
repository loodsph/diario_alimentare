import test from 'node:test';
import assert from 'node:assert/strict';
import { createMealEntry } from '../public/modules/mealEntry.js';

function fixture(onCustomContinue) {
    const fields = new Map();
    function element(id) {
        if (!fields.has(id)) {
            const classes = new Set();
            const attributes = new Map();
            const events = new Map();
            fields.set(id, {
                textContent: '', dataset: {}, focused: false,
                classList: { toggle(name, yes) { yes ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
                setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
                addEventListener: (key, fn) => events.set(key, fn),
                click() { events.get('click')?.({ preventDefault() {} }); },
                focus() { this.focused = true; }, querySelector: () => element(id + '-title')
            });
        }
        return fields.get(id);
    }
    const tabs = ['diary', 'insights', 'library'].map(name => {
        const el = element(name + '-tab'); el.dataset.view = name; return el;
    });
    element('current-date-display').textContent = '21 ottobre 2026';
    const root = { getElementById: id => id === 'dynamic-search-results' ? null : element(id), querySelector: element, querySelectorAll: () => tabs };
    const flow = createMealEntry(root, { onCustomContinue });
    const visible = id => !element(id).classList.contains('hidden');
    return { flow, element, visible };
}

test('a draft keeps its portion step when closed, but successful reset starts a fresh entry', () => {
    const { flow, element, visible } = fixture();
    assert.ok(visible('view-diary'));
    assert.ok(!visible('add-meal-card'));
    element('open-meal-entry').click();
    assert.ok(visible('entry-food'));
    flow.select({ name: 'Yogurt' });
    assert.ok(visible('entry-portion'));
    assert.equal(element('selected-food-name').textContent, 'Yogurt');
    element('close-meal-entry').click();
    assert.ok(visible('view-diary'));
    element('open-meal-entry').click();
    assert.ok(visible('entry-portion'));
    flow.reset();
    element('open-meal-entry').click();
    assert.ok(visible('entry-food'));
    assert.ok(!visible('entry-portion'));
});

test('manual entry only advances after valid data; recipes open from the library', () => {
    let valid = false;
    const { flow, element, visible } = fixture(() => valid && { name: 'Piatto' });
    flow.open();
    element('continue-custom-meal').click();
    assert.ok(visible('entry-food'));
    valid = true;
    element('continue-custom-meal').click();
    assert.ok(visible('entry-portion'));
    element('change-meal-food').click();
    assert.ok(visible('entry-food'));
    flow.close();
    element('library-tab').click();
    assert.ok(visible('view-library'));
    assert.ok(!visible('view-diary'));
    flow.select({ name: 'Zuppa' });
    assert.ok(!visible('view-library'));
    assert.ok(visible('add-meal-card'));
    assert.ok(visible('entry-portion'));
    assert.equal(element('entry-date').textContent, '21 ottobre 2026');
});

test('save and add another keeps the editor open at search without returning to the diary', () => {
    const { flow, visible } = fixture();
    flow.select({ name: 'Pane' });
    flow.reset(true);
    assert.ok(visible('add-meal-card'));
    assert.ok(visible('entry-food'));
    assert.ok(!visible('entry-portion'));
    assert.ok(!visible('view-diary'));
});
