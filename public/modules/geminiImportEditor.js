import { GEMINI_INSTRUCTIONS, parseGeminiText, importedPortionToFood, importNutrientLabels } from './geminiImport.js';

export function createGeminiImportEditor(root, onSelect) {
    const dialog = root.createElement('dialog');
    dialog.className = 'estimate-dialog dish-dialog gemini-import-dialog modal-content';
    dialog.setAttribute('aria-labelledby', 'gemini-import-title');
    dialog.innerHTML = `
        <div class="estimate-heading"><div><p class="eyebrow">DA GEMINI AL DIARIO</p><h2 id="gemini-import-title">Incolla la tua stima.</h2></div><button type="button" class="icon-button" id="gemini-import-close" aria-label="Chiudi importazione">×</button></div>
        <p class="muted">Invia una foto o descrivi il pasto in Gemini, rispondi alle sue domande e incolla qui il risultato. I valori si riferiscono a tutta la porzione che hai mangiato.</p>
        <details class="dish-section" id="gemini-instructions-details"><summary>Prima volta? Prepara il tuo Gem</summary>
            <p class="muted">In Gemini crea un Gem chiamato “NutriTrack” e incolla queste istruzioni. Puoi anche usarle all’inizio di una normale chat.</p>
            <label>Istruzioni da copiare<textarea id="gemini-instructions" class="input-modern" rows="7" readonly></textarea></label>
            <button type="button" class="text-button" id="gemini-copy-instructions">Copia istruzioni</button><p class="muted" id="gemini-copy-status" role="status"></p>
        </details>
        <p class="gemini-open"><a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">Apri Gemini ↗</a></p>
        <form id="gemini-import-form" class="dish-section">
            <label>Risultato di Gemini<textarea id="gemini-import-text" class="input-modern" rows="7" maxlength="6000" spellcheck="false" placeholder="Nome: Pollo con riso&#10;P: 25&#10;C: 12&#10;G: 2&#10;kcal: 166" required aria-describedby="gemini-format-hint"></textarea></label>
            <p class="muted" id="gemini-format-hint">P, C, G e kcal sono obbligatori. Nome, F (fibre) e Note sono facoltativi. Accettiamo anche “kal” e le virgole decimali.</p>
            <p id="gemini-import-error" role="alert"></p>
            <button class="btn-modern btn-primary" type="submit">Controlla i valori</button>
        </form>
        <section class="dish-section hidden" id="gemini-import-result">
            <p class="eyebrow">PER LA PORZIONE MANGIATA</p><h3 id="gemini-result-title" tabindex="-1">Controlla la tua stima</h3>
            <form id="gemini-result-form">
                <label>Nome del pasto<input name="mealName" class="input-modern" maxlength="200" placeholder="Es. pranzo al ristorante" required></label>
                <div class="estimate-nutrients">${Object.entries(importNutrientLabels).map(([key, label]) => `<label>${label}<input name="${key}" class="input-modern" type="number" min="0" max="100000" step="any" inputmode="decimal" ${key === 'fibers' ? 'placeholder="Non disponibili"' : 'required'}></label>`).join('')}</div>
                <p id="gemini-import-notes" class="muted"></p>
                <p class="muted">Puoi correggere i valori. Le fibre lasciate vuote non contribuiscono al totale. Nel prossimo passaggio 1 porzione corrisponde a tutto il pasto descritto a Gemini; scegli ½ solo per registrarne la metà.</p>
                <p id="gemini-result-error" role="alert"></p>
                <button class="btn-modern btn-primary" type="submit">Usa questa porzione →</button>
            </form>
        </section>`;
    root.body.appendChild(dialog);
    const get = id => dialog.querySelector(`#${id}`);
    const form = get('gemini-import-form'), resultForm = get('gemini-result-form');
    const field = key => resultForm.elements.namedItem(key);
    const instructions = get('gemini-instructions');
    instructions.value = GEMINI_INSTRUCTIONS;
    let parsed = null, opener;
    function invalidate() {
        parsed = null;
        get('gemini-import-result').classList.add('hidden');
        get('gemini-import-error').textContent = '';
        get('gemini-result-error').textContent = '';
    }
    function close() { dialog.close(); opener?.focus(); }
    get('gemini-import-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    get('gemini-import-text').addEventListener('input', invalidate);
    get('gemini-copy-instructions').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(GEMINI_INSTRUCTIONS);
            get('gemini-copy-status').textContent = 'Istruzioni copiate. Incollale in Gemini.';
        } catch {
            instructions.focus(); instructions.select();
            get('gemini-copy-status').textContent = 'Selezione pronta: copia il testo con il menu del dispositivo.';
        }
    });
    form.addEventListener('submit', event => {
        event.preventDefault(); invalidate();
        try {
            parsed = parseGeminiText(get('gemini-import-text').value);
            field('mealName').value = parsed.name;
            Object.keys(importNutrientLabels).forEach(key => { field(key).value = parsed.values[key] ?? ''; });
            get('gemini-import-notes').textContent = parsed.notes;
            get('gemini-import-result').classList.remove('hidden');
            get('gemini-result-title').focus();
        } catch (error) { get('gemini-import-error').textContent = error.message; }
    });
    resultForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!parsed) return;
        try {
            const values = Object.fromEntries(Object.keys(importNutrientLabels).map(key => [key, field(key).value]));
            const food = importedPortionToFood(parsed, field('mealName').value, values);
            close(); onSelect(food); reset();
        } catch (error) { get('gemini-result-error').textContent = error.message; }
    });
    function reset() { form.reset(); resultForm.reset(); invalidate(); get('gemini-copy-status').textContent = ''; }
    return {
        open() { opener = root.activeElement; dialog.showModal(); get('gemini-import-text').focus(); },
        reset() { close(); reset(); }
    };
}
