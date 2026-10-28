import { estimateCatalog, estimateRow, buildMealEstimate, estimateRange } from './mealEstimate.js';
import { nutrientKeys, formatAmount } from './portions.js?v=20261025';

const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const labels = { calories: 'kcal', proteins: 'Proteine', carbs: 'Carboidrati', fats: 'Grassi', fibers: 'Fibre' };
export function createEstimateEditor(root, onSelect) {
    const dialog = root.createElement('dialog');
    dialog.className = 'estimate-dialog modal-content';
    dialog.setAttribute('aria-labelledby', 'estimate-title');
    dialog.innerHTML = `
        <div class="estimate-heading"><div><p class="eyebrow">SENZA BILANCIA</p><h2 id="estimate-title">Il pasto, in pezzi.</h2></div><button type="button" class="icon-button" aria-label="Chiudi stima">×</button></div>
        <p class="muted">Conta solo quello che hai mangiato tu. Puoi usare anche mezzo pezzo: 0,5.</p>
        <div class="estimate-tabs" role="group" aria-label="Tipo di stima"><button type="button" data-kind="grill" class="portion-chip">Grigliata</button><button type="button" data-kind="sushi" class="portion-chip">Sushi</button></div>
        <p class="muted" id="estimate-guidance"></p>
        <div class="estimate-add"><div><label for="estimate-food" class="input-label">Che cosa hai mangiato?</label><select id="estimate-food" class="input-modern"></select></div><button type="button" id="estimate-add" class="btn-modern btn-secondary">Aggiungi</button></div>
        <div id="estimate-items"></div>
        <details class="estimate-method"><summary>Come funziona la stima</summary><p>I pesi dei pezzi sono ipotesi iniziali, non porzioni standard. I valori nutrizionali sono riferimenti o modelli indicativi, modificabili in “Correggi peso e valori”. Per la carne usa il peso cotto effettivamente mangiato, senza ossa e parti scartate. Per il sushi conta i singoli pezzi, non i roll interi.</p><p>L’intervallo applica un margine convenzionale del ±30% alla grigliata e del ±35% al sushi. Non è un intervallo statistico né garantisce che il pasto reale vi rientri. Nel diario viene usata la stima centrale. Le fibre non riportate dalla fonte sono approssimate a zero.</p></details>
        <div class="estimate-footer"><p id="estimate-total" role="status" aria-live="polite"></p><p id="estimate-error" role="alert"></p><button type="button" id="estimate-continue" class="btn-modern btn-primary">Usa questa stima →</button></div>`;
    root.body.appendChild(dialog);
    const get = id => dialog.querySelector(`#${id}`);
    const list = get('estimate-items');
    let kind = 'grill', drafts = { grill: [], sushi: [] }, opener, apply = onSelect;
    const rows = () => drafts[kind];
    function update() {
        try {
            const food = buildMealEstimate(kind, rows());
            const total = food.calories * food.quantity / 100;
            get('estimate-total').textContent = `Circa ${Math.round(total)} kcal · ${estimateRange(food)}. Proteine ${Math.round(food.proteins * food.quantity / 100)} g · Carboidrati ${Math.round(food.carbs * food.quantity / 100)} g · Grassi ${Math.round(food.fats * food.quantity / 100)} g`;
            get('estimate-error').textContent = '';
            get('estimate-continue').disabled = false;
        } catch (error) {
            get('estimate-total').textContent = rows().length ? 'Completa i dati per calcolare la stima.' : 'Aggiungi il primo alimento per iniziare.';
            get('estimate-error').textContent = rows().length ? error.message : '';
            get('estimate-continue').disabled = true;
        }
        get('estimate-add').disabled = rows().length >= 30;
    }
    function renderRows() {
        list.innerHTML = rows().map((row, index) => {
            const reference = estimateCatalog.find(item => item.id === row.id);
            return `<section class="estimate-row" data-index="${index}">
                <div class="estimate-row-title"><h3>${escape(row.name)}</h3><button type="button" data-remove="${index}" class="text-button" aria-label="Rimuovi ${escape(row.name)}">Rimuovi</button></div>
                <div class="estimate-controls"><label>Quantità (${escape(row.unit)})<input class="input-modern" data-field="count" aria-label="Quantità ${escape(row.name)}" type="number" min="0.01" max="10000" step="any" inputmode="decimal" value="${escape(row.count)}"></label>
                <label>Dimensione<select class="input-modern" data-size aria-label="Dimensione ${escape(row.name)}"><option value="custom">Personalizzata</option>${[[0.75, 'Piccola'], [1, 'Media'], [1.25, 'Grande']].map(([factor, label]) => `<option value="${factor}" ${row.grams === reference.grams * factor ? 'selected' : ''}>${label} · ${formatAmount(reference.grams * factor)} g</option>`).join('')}</select></label></div>
                <details><summary>Correggi peso e valori</summary><p class="muted">${escape(reference.note)} ${reference.source ? `<a href="${escape(reference.source)}" target="_blank" rel="noopener noreferrer">Fonte nutrizionale ↗</a>` : ''}</p>
                <label class="estimate-weight">Peso edibile di una unità (g)<input class="input-modern" data-field="grams" aria-label="Peso per unità ${escape(row.name)}" type="number" min="0.01" max="10000" step="any" inputmode="decimal" value="${escape(row.grams)}"></label>
                <p class="muted">Valori per 100 g, non per pezzo. Puoi usare quelli del ristorante o della confezione.</p>
                <div class="estimate-nutrients">${nutrientKeys.map(key => `<label>${labels[key]}${key === 'calories' ? '' : ' (g)'}<input class="input-modern" data-field="${key}" aria-label="${labels[key]} per 100 g ${escape(row.name)}" type="number" min="0" max="1000" step="any" inputmode="decimal" value="${escape(row[key])}"></label>`).join('')}</div>
                </details></section>`;
        }).join('');
        update();
    }
    function renderKind() {
        dialog.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === kind)));
        get('estimate-guidance').textContent = kind === 'grill'
            ? 'I grammi indicano la carne cotta edibile: ossa escluse. Aggiungi a parte pane, contorni, olio e bevande.'
            : 'Un pezzo è un singolo boccone. Scegli i roll ricchi per fritti o maionese; aggiungi solo i condimenti extra.';
        get('estimate-food').innerHTML = [kind, 'extra'].map(group => `<optgroup label="${group === 'extra' ? 'Contorni, condimenti e bevande' : kind === 'grill' ? 'Carne' : 'Sushi'}">${estimateCatalog.filter(item => item.group === group).map(item => `<option value="${item.id}">${item.name}</option>`).join('')}</optgroup>`).join('');
        renderRows();
    }
    function close() { dialog.close(); opener?.focus(); }
    dialog.querySelector('[aria-label="Chiudi stima"]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => { kind = button.dataset.kind; renderKind(); }));
    get('estimate-add').addEventListener('click', () => {
        if (rows().length >= 30) return;
        rows().push(estimateRow(get('estimate-food').value));
        renderRows();
        list.lastElementChild.querySelector('input').focus();
    });
    list.addEventListener('click', event => {
        const button = event.target.closest('[data-remove]');
        if (!button) return;
        rows().splice(Number(button.dataset.remove), 1);
        renderRows(); get('estimate-add').focus();
    });
    list.addEventListener('input', event => {
        const input = event.target;
        if (!input.dataset.field) return;
        const section = input.closest('[data-index]');
        rows()[Number(section.dataset.index)][input.dataset.field] = input.value === '' ? '' : Number(input.value);
        if (input.dataset.field === 'grams') section.querySelector('[data-size]').value = 'custom';
        update();
    });
    list.addEventListener('change', event => {
        const input = event.target;
        if (!input.hasAttribute('data-size') || input.value === 'custom') return;
        const section = input.closest('[data-index]');
        const row = rows()[Number(section.dataset.index)];
        row.grams = estimateCatalog.find(item => item.id === row.id).grams * Number(input.value);
        section.querySelector('[data-field="grams"]').value = row.grams;
        update();
    });
    get('estimate-continue').addEventListener('click', () => {
        try { const food = buildMealEstimate(kind, rows()); close(); apply(food); }
        catch (error) { get('estimate-error').textContent = error.message; }
    });
    return { open(food = null, quantity = food?.quantity, onApply = onSelect) {
        apply = onApply;
        opener = root.activeElement;
        drafts = { grill: [], sushi: [] };
        kind = food?.estimate?.kind || 'grill';
        if (food?.estimate) {
            const factor = quantity / food.estimate.baseGrams;
            drafts[kind] = food.estimate.items.map(row => ({ ...row, count: row.count * factor }));
        }
        renderKind(); dialog.showModal();
    }, close };
}
