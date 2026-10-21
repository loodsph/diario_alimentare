import { portionOptions, quantityInGrams, positive, formatAmount } from './portions.js';

export function createPortionPicker(root, onChange) {
    const get = id => root.getElementById(id);
    const amount = get('meal-quantity');
    const select = get('portion-unit');
    const hint = get('portion-hint');
    const shortcuts = get('portion-shortcuts');
    let food = {};
    let customUnit = null;
    let options = portionOptions();
    let origin = '';

    const currentUnit = () => options.find(unit => unit.id === select.value) || options[0];

    function render() {
        const unit = currentUnit();
        const quantity = quantityInGrams(amount.value, unit);
        const minus = get('portion-minus');
        if (minus) minus.disabled = !positive(Number(amount.value)) || Number(amount.value) <= (unit.id === 'g' ? 10 : 0.25);
        get('meal-quantity-label').textContent = unit.id === 'g' ? 'Quantità in grammi' : 'Quante unità?';
        const recipeWarning = food.isRecipe && !positive(food.finalWeight)
            ? ' Il peso cotto non è registrato: usa le porzioni o una frazione della ricetta.' : '';
        hint.textContent = `${origin ? `${origin}. ` : ''}${unit.id === 'g'
            ? (positive(quantity) ? `${formatAmount(quantity)} g` : 'Inserisci il peso oppure definisci una tua misura.')
            : `1 unità = ${formatAmount(unit.grams)} g · ${unit.source}${positive(quantity) ? ` · Totale ${formatAmount(quantity)} g` : ''}`}${recipeWarning}${food.estimated ? ' Stima da foto, da verificare.' : ''}`;
        shortcuts.replaceChildren();
        if (unit.id !== 'g') {
            const values = unit.id === 'recipe' || unit.id === 'package' ? [0.25, 0.5, 0.75, 1] : [0.5, 1, 1.5, 2];
            values.forEach(value => {
                const button = root.createElement('button');
                button.type = 'button';
                button.className = 'portion-chip';
                button.textContent = ({0.25: '¼', 0.5: '½', 0.75: '¾', 1.5: '1½'})[value] || String(value);
                button.setAttribute('aria-label', `${formatAmount(value)} × ${unit.label}`);
                button.setAttribute('aria-pressed', String(Number(amount.value) === value));
                button.addEventListener('click', () => {
                    amount.value = value;
                    origin = '';
                    render();
                    onChange();
                });
                shortcuts.appendChild(button);
            });
        }
    }

    function fillOptions() {
        options = portionOptions(food, customUnit);
        select.replaceChildren();
        options.forEach(unit => {
            const option = root.createElement('option');
            option.value = unit.id;
            option.textContent = unit.label;
            select.appendChild(option);
        });
    }

    amount.addEventListener('input', () => { origin = ''; render(); onChange(); });
    select.addEventListener('change', () => {
        // Switching units preserves the chosen amount of food.
        const grams = Number(amount.dataset.lastGrams);
        amount.value = positive(grams) ? Number((grams / currentUnit().grams).toFixed(4)) : '';
        origin = '';
        render();
        onChange();
    });
    // Store the last total before the unit select changes.
    function trackQuantity() {
        amount.dataset.lastGrams = quantityInGrams(amount.value, currentUnit());
    }
    amount.addEventListener('input', trackQuantity);
    shortcuts.addEventListener('click', trackQuantity);
    select.addEventListener('change', trackQuantity);

    for (const [id, direction] of [['portion-minus', -1], ['portion-plus', 1]]) {
        get(id)?.addEventListener('click', () => {
            const step = currentUnit().id === 'g' ? 10 : 0.25;
            const value = Number(amount.value) || 0;
            amount.value = Number(Math.max(step, value + direction * step).toFixed(4));
            origin = '';
            render();
            trackQuantity();
            onChange();
        });
    }

    get('save-portion-unit').addEventListener('click', () => {
        const label = get('custom-portion-label').value.trim();
        const grams = Number(get('custom-portion-grams').value);
        const error = get('portion-unit-error');
        if (!label || !positive(grams)) {
            error.textContent = 'Dai un nome alla misura e inserisci un peso maggiore di zero.';
            return;
        }
        error.textContent = '';
        customUnit = { label, grams };
        fillOptions();
        select.value = 'custom';
        amount.value = 1;
        origin = 'La misura sarà ricordata su questo dispositivo dopo aver aggiunto il pasto';
        render();
        trackQuantity();
        onChange();
    });

    return {
        select(foodData = {}, saved = null) {
            food = foodData;
            customUnit = saved?.customUnit || foodData.customUnit || null;
            fillOptions();
            const savedUnit = options.find(unit => unit.id === saved?.portion?.unitId);
            if (savedUnit && positive(saved.portion.amount)) {
                select.value = savedUnit.id;
                amount.value = saved.portion.amount;
                origin = 'Porzione salvata';
            } else if (positive(saved?.quantity)) {
                select.value = 'g';
                amount.value = saved.quantity;
                origin = foodData.estimated && !saved?.portion ? 'Quantità proposta dalla foto' : 'Quantità salvata';
            } else if (food.isRecipe || positive(food.servingGrams) || positive(food.packageGrams)) {
                select.value = options.some(unit => unit.id === 'serving') ? 'serving' : 'package';
                amount.value = 1;
                origin = 'Quantità proposta: controlla quanto hai mangiato';
            } else {
                select.value = 'g';
                amount.value = '';
                origin = '';
            }
            get('portion-help').open = false;
            get('custom-portion-label').value = customUnit?.label || '';
            get('custom-portion-grams').value = customUnit?.grams || '';
            get('portion-unit-error').textContent = '';
            render();
            trackQuantity();
        },
        quantity: () => quantityInGrams(amount.value, currentUnit()),
        customUnit: () => customUnit,
        metadata() {
            const unit = currentUnit();
            return {
                unitId: unit.id, label: unit.label, amount: Number(amount.value), gramsPerUnit: unit.grams, source: unit.source,
                ingredientWeight: Boolean(food.isRecipe && !positive(food.finalWeight))
            };
        }
    };
}
