import { dishOptions, analyzeDish, normalizeDishInput, dishToFood } from './aiDishAnalysis.js';
import { getGeminiApiKey, saveGeminiApiKey } from './aiPhotoAnalysis.js';

const options = key => dishOptions[key].map(value => `<option>${value}</option>`).join('');
const select = (key, label) => `<label>${label}<select class="input-modern" name="${key}">${options(key)}</select></label>`;
const nutrientLabels = { calories: 'Energia (kcal)', proteins: 'Proteine (g)', carbs: 'Carboidrati (g)', fats: 'Grassi (g)', fibers: 'Fibre (g)' };

export function createDishEstimateEditor(root, onSelect) {
    const dialog = root.createElement('dialog');
    dialog.className = 'estimate-dialog dish-dialog modal-content';
    dialog.setAttribute('aria-labelledby', 'dish-title');
    dialog.innerHTML = `
        <div class="estimate-heading"><div><p class="eyebrow">STIMA CON GEMINI</p><h2 id="dish-title">Descrivi il tuo piatto.</h2></div><button type="button" class="icon-button" id="dish-close" aria-label="Chiudi descrizione piatto">×</button></div>
        <p class="muted">Parti dal nome e aggiungi quello che sai. Più dettagli aiutano la stima; puoi lasciare vuote le quantità sconosciute.</p>
        <form id="dish-form">
        <fieldset id="dish-fields">
            <section class="dish-section">
                <label>Nome del piatto <span class="muted">· obbligatorio</span><input name="name" class="input-modern" placeholder="Es. polpette di carne" maxlength="200" required></label>
                <div class="dish-grid">${select('origin', 'Da dove arriva?')}${select('state', 'Valori per 100 g di alimento…')}</div>
            </section>
            <section class="dish-section">
                <h3>Ingredienti</h3><p class="muted">Quantità per tutta la preparazione, non solo la tua porzione. Specifica tipo di carne, taglio, formaggio o marca se li conosci.</p>
                ${select('completeness', 'Quanto conosci della ricetta?')}
                <div id="dish-ingredients"></div>
                <button type="button" id="dish-add-ingredient" class="text-button">+ Aggiungi ingrediente</button>
            </section>
            <section class="dish-section">
                <h3>Cottura e condimenti</h3>
                <div class="dish-grid">${select('cooking', 'Metodo di cottura')}${select('coating', 'Panatura o rivestimento')}${select('fat', 'Grasso aggiunto')}${select('sauce', 'Salsa o sugo')}</div>
                <div id="dish-fat-details">
                    <div class="dish-grid"><label>Quantità di grasso aggiunto<input name="fatAmount" class="input-modern" type="number" min="0.01" max="100000" step="any" inputmode="decimal" placeholder="Non so"></label><label>Unità<select name="fatUnit" class="input-modern">${options('unit')}</select></label></div>
                    ${select('fatRetention', 'Quanto condimento resta nel piatto?')}
                </div>
                <p class="muted">Indica olio, panatura e salsa una volta sola. Se conosci le dosi di panatura o salsa, aggiungile tra gli ingredienti.</p>
            </section>
            <section class="dish-section">
                <h3>Peso e altri dettagli</h3>
                <label>Peso totale edibile, nello stato scelto (g)<input name="finalWeight" class="input-modern" type="number" min="0.01" max="100000" step="any" inputmode="decimal" placeholder="Facoltativo · es. 850"></label>
                <p class="muted">Se scegli “cotto”, pesa tutta la preparazione dopo la cottura, senza recipiente, ossa e scarti. La tua porzione si sceglie dopo.</p>
                <label>Altre informazioni<textarea name="notes" class="input-modern" rows="3" maxlength="1500" placeholder="Es. manzo magro, pane ammollato nel latte, sugo incluso; olio rimasto in padella…"></textarea></label>
            </section>
        </fieldset>
        <details id="dish-key-settings" class="dish-section"><summary>Chiave Gemini</summary>
            <p class="muted" id="dish-key-status"></p>
            <label>API key di Google AI Studio<input id="dish-key" class="input-modern" type="password" autocomplete="off" placeholder="Incolla la tua chiave"></label>
            <label class="dish-check"><input id="dish-remember-key" type="checkbox"> Ricorda la chiave su questo dispositivo, anche per le foto</label>
            <p class="muted">I dettagli del piatto vengono inviati a Google quando premi “Stima”. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Gestisci chiave e quota ↗</a></p>
        </details>
        <p id="dish-status" role="status" aria-live="polite"></p>
        <p id="dish-error" role="alert"></p>
        <button id="dish-submit" class="btn-modern btn-primary" type="submit">Stima valori per 100 g</button>
        </form>
        <section id="dish-result" class="dish-section hidden" aria-labelledby="dish-result-title">
            <p class="eyebrow">DA VERIFICARE</p><h3 id="dish-result-title" tabindex="-1">La tua stima per 100 g</h3>
            <p class="muted">Puoi correggere questi valori prima di scegliere la porzione.</p>
            <form id="dish-result-form">
                <label>Nome dell’alimento<input name="resultName" class="input-modern" maxlength="200" required></label>
                <div class="estimate-nutrients">${Object.entries(nutrientLabels).map(([key, label]) => `<label>${label}<input name="${key}" class="input-modern" type="number" min="0" max="${key === 'calories' ? 950 : 100}" step="any" inputmode="decimal" required></label>`).join('')}</div>
                <div class="dish-assumptions"><h4>Ipotesi usate da Gemini</h4><ul id="dish-assumptions"></ul><p id="dish-notes" class="muted"></p></div>
                <p class="muted">È una stima da descrizione. Resterà indicata come tale nel diario. Puoi conservarla nei preferiti dopo aver scelto la porzione.</p>
                <p id="dish-result-error" role="alert"></p>
                <button class="btn-modern btn-primary" type="submit">Usa questi valori →</button>
            </form>
        </section>`;
    root.body.appendChild(dialog);
    const get = id => dialog.querySelector(`#${id}`);
    const form = get('dish-form');
    const resultForm = get('dish-result-form');
    const field = name => form.elements.namedItem(name);
    const list = get('dish-ingredients');
    let opener, controller, result, submitted, ingredientId = 0;
    const storedKey = () => { try { return getGeminiApiKey(); } catch { return ''; } };
    function invalidate() {
        result = null;
        get('dish-result').classList.add('hidden');
        get('dish-error').textContent = '';
        get('dish-status').textContent = '';
    }
    function addIngredient() {
        if (list.children.length >= 20) return;
        const row = root.createElement('div');
        row.className = 'dish-ingredient';
        const id = ++ingredientId;
        row.innerHTML = `<label class="dish-ingredient-name">Ingrediente<input class="input-modern" data-field="name" maxlength="200" placeholder="Es. macinato di manzo" aria-label="Ingrediente ${id}"></label>
            <label>Quantità<input class="input-modern" data-field="amount" type="number" min="0.01" max="100000" step="any" inputmode="decimal" placeholder="Non so" aria-label="Quantità ingrediente ${id}"></label>
            <label>Unità<select class="input-modern" data-field="unit" aria-label="Unità ingrediente ${id}">${options('unit')}</select></label>
            <label>Stato al peso<select class="input-modern" data-field="state" aria-label="Stato ingrediente ${id}">${options('ingredientState')}</select></label>
            <button type="button" class="text-button" data-remove aria-label="Rimuovi ingrediente ${id}">Rimuovi</button>`;
        list.appendChild(row);
        get('dish-add-ingredient').disabled = list.children.length >= 20;
        return row;
    }
    function readInput() {
        const data = Object.fromEntries(['name', 'origin', 'state', 'cooking', 'completeness', 'fat', 'fatAmount', 'fatUnit', 'fatRetention', 'coating', 'sauce', 'finalWeight', 'notes'].map(name => [name, field(name).value]));
        data.ingredients = [...list.children].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value])));
        return normalizeDishInput(data);
    }
    function busy(value) {
        get('dish-fields').disabled = value;
        get('dish-submit').disabled = value;
        get('dish-submit').textContent = value ? 'Stima in corso…' : 'Stima valori per 100 g';
        form.setAttribute('aria-busy', String(value));
    }
    function close() {
        controller?.abort(); controller = null;
        busy(false);
        get('dish-status').textContent = '';
        get('dish-key').value = '';
        dialog.close(); opener?.focus();
    }
    get('dish-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    get('dish-add-ingredient').addEventListener('click', () => { invalidate(); addIngredient()?.querySelector('input').focus(); });
    list.addEventListener('click', event => {
        const button = event.target.closest('[data-remove]');
        if (!button) return;
        button.closest('.dish-ingredient').remove();
        get('dish-add-ingredient').disabled = false;
        invalidate(); get('dish-add-ingredient').focus();
    });
    get('dish-fields').addEventListener('input', invalidate);
    get('dish-fields').addEventListener('change', () => {
        invalidate();
        const noFat = ['Nessuno', 'Già indicato negli ingredienti'].includes(field('fat').value);
        get('dish-fat-details').classList.toggle('hidden', noFat);
        field('fatAmount').disabled = noFat;
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (controller) return;
        invalidate();
        try {
            submitted = readInput();
            const typedKey = get('dish-key').value.trim();
            const apiKey = typedKey || storedKey();
            if (!apiKey) {
                get('dish-key-settings').open = true;
                get('dish-key').focus();
                throw new Error('Inserisci la tua chiave Gemini per stimare il piatto.');
            }
            if (typedKey && get('dish-remember-key').checked) {
                try { saveGeminiApiKey(typedKey); }
                catch { throw new Error('Non riesco a ricordare la chiave. Deseleziona “Ricorda la chiave” per usarla solo questa volta.'); }
            }
            const request = new AbortController();
            controller = request;
            busy(true);
            get('dish-status').textContent = 'Gemini sta stimando ricetta, resa e valori nutrizionali…';
            const timeout = setTimeout(() => request.abort(), 60000);
            try {
                const response = await analyzeDish(apiKey, submitted, { signal: request.signal });
                if (controller !== request || request.signal.aborted) return;
                result = response;
                resultForm.elements.namedItem('resultName').value = result.name;
                Object.keys(nutrientLabels).forEach(key => { resultForm.elements.namedItem(key).value = result.values[key]; });
                get('dish-assumptions').replaceChildren(...result.assumptions.map(note => { const li = root.createElement('li'); li.textContent = note; return li; }));
                get('dish-notes').textContent = result.notes;
                get('dish-result-error').textContent = '';
                get('dish-result').classList.remove('hidden');
                get('dish-status').textContent = 'Stima pronta. Verifica valori e ipotesi qui sotto.';
                get('dish-result-title').focus();
            } catch (error) {
                if (controller !== request) return;
                get('dish-status').textContent = '';
                get('dish-error').textContent = error.name === 'AbortError' ? 'La richiesta ha impiegato troppo tempo. Riprova.' : error instanceof TypeError ? 'Connessione non disponibile. Controlla la rete e riprova.' : error.message;
            } finally {
                clearTimeout(timeout);
                if (controller === request) { controller = null; busy(false); }
            }
        } catch (error) { get('dish-error').textContent = error.message; }
    });
    resultForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!result) return;
        try {
            const values = Object.fromEntries(Object.keys(nutrientLabels).map(key => [key, resultForm.elements.namedItem(key).valueAsNumber]));
            const food = dishToFood(result, submitted, values, resultForm.elements.namedItem('resultName').value);
            close(); onSelect(food); reset();
        } catch (error) { get('dish-result-error').textContent = error.message; }
    });
    function reset() {
        form.reset(); resultForm.reset(); list.replaceChildren(); addIngredient();
        get('dish-fat-details').classList.remove('hidden'); field('fatAmount').disabled = false;
        invalidate(); submitted = null;
    }
    reset();
    return {
        open() {
            opener = root.activeElement;
            const hasKey = Boolean(storedKey());
            get('dish-key-settings').open = !hasKey;
            get('dish-key-status').textContent = hasKey ? 'Useremo la chiave già salvata per le foto. Puoi inserirne una diversa.' : 'Serve una chiave Google AI Studio. Puoi usarla solo questa volta o ricordarla sul dispositivo.';
            dialog.showModal(); field('name').focus();
        }, close,
        reset() { close(); reset(); }
    };
}
