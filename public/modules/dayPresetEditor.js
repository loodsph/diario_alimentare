import { buildDayPreset, readDayPreset } from './dayPreset.js';
import { mealNutrition } from './nutrition.js';
import { formatDate } from './utils.js';

const labels = { calories: 'Calorie (kcal)', proteins: 'Proteine (g)', carbs: 'Carboidrati (g)', fats: 'Grassi (g)', fibers: 'Fibre (g)' };
export function createDayPresetEditor(root, onSave) {
    const dialog = root.createElement('dialog');
    dialog.className = 'estimate-dialog modal-content day-preset-dialog';
    dialog.setAttribute('aria-labelledby', 'day-preset-title');
    dialog.innerHTML = `<form novalidate>
        <div class="estimate-heading"><div><p class="eyebrow">PRESET GIORNALIERO</p><h2 id="day-preset-title">Giorno sgarro</h2></div><button type="button" class="icon-button" data-close aria-label="Chiudi preset">×</button></div>
        <p class="muted" id="day-preset-date"></p>
        <p class="muted">Inserisci la tua stima per l’intera giornata. I valori iniziali sono un esempio modificabile, non una stima di ciò che hai mangiato.</p>
        <div class="estimate-nutrients">${Object.entries(labels).map(([key, label]) => `<label>${label}<input class="input-modern" name="${key}" type="number" min="${key === 'calories' ? '0.01' : '0'}" step="any" inputmode="decimal" required></label>`).join('')}</div>
        <p class="muted">La stima sarà usata nei totali e nei grafici. I pasti già registrati restano nel diario e non si sommano: rimuovendo il preset torneranno i loro totali.</p>
        <label class="day-preset-remember"><input type="checkbox" name="remember" checked> Ricorda questi valori per le prossime volte su questo dispositivo</label>
        <div class="estimate-footer"><p id="day-preset-error" role="alert"></p><button type="submit" class="btn-modern btn-primary">Applica alla giornata</button></div>
    </form>`;
    root.body.appendChild(dialog);
    const form = dialog.querySelector('form');
    let context = null, opener = null;
    function close() { dialog.close(); context = null; opener?.focus(); }
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (!context) return;
        try {
            const meal = buildDayPreset(Object.fromEntries(Object.keys(labels).map(key => [key, form.elements.namedItem(key).value])));
            onSave(meal, { ...context, remember: form.elements.namedItem('remember').checked });
            close();
        } catch (error) { dialog.querySelector('#day-preset-error').textContent = error.message; }
    });
    return { close, open({ owner, date, meal = null, storage }) {
        context = { owner, date: new Date(date), id: meal?.id };
        opener = root.activeElement;
        const values = meal ? mealNutrition(meal) : readDayPreset(storage, owner);
        for (const key of Object.keys(labels)) form.elements.namedItem(key).value = values[key];
        form.elements.namedItem('remember').checked = true;
        dialog.querySelector('#day-preset-date').textContent = formatDate(date);
        dialog.querySelector('#day-preset-error').textContent = '';
        dialog.showModal();
        form.elements.namedItem('calories').focus();
    } };
}
