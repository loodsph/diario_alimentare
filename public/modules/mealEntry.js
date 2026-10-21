/** Page navigation and the food → portion flow; data and persistence stay in script.js. */
export function createMealEntry(root, { onCustomContinue = () => false } = {}) {
    const get = id => root.getElementById(id);
    let view = 'diary';
    let step = 'food';
    let editing = false;
    function paint() {
        get("entry-date").textContent = get("current-date-display").textContent;
        for (const name of ['diary', 'insights', 'library']) {
            get(`view-${name}`).classList.toggle('hidden', editing || view !== name);
        }
        get('add-meal-card').classList.toggle('hidden', !editing);
        get('diary-intro').classList.toggle('hidden', editing || view !== 'diary');
        get('date-navigation').classList.toggle('hidden', editing || view === 'library');
        root.querySelector('.app-nav').classList.toggle('hidden', editing);
        root.querySelectorAll('[data-view]').forEach(button => {
            if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        for (const name of ['food', 'portion']) {
            get(`entry-${name}`).classList.toggle('hidden', name !== step);
            if (name === step) get(`step-${name}-label`).setAttribute('aria-current', 'step');
            else get(`step-${name}-label`).removeAttribute('aria-current');
        }
        // Search dropdowns live on body; never leave one floating over another page.
        const dropdown = get('dynamic-search-results');
        dropdown?._cleanup?.();
        dropdown?.remove();
    }
    function focusStep() {
        get(`entry-${step}`).querySelector('h2').focus();
    }
    function open() { editing = true; paint(); focusStep(); }
    function close() {
        editing = false; view = 'diary'; paint();
        get('open-meal-entry').focus();
    }
    function select(food) {
        get('selected-food-name').textContent = food.name;
        step = 'portion'; editing = true; paint(); focusStep();
    }
    function reset() { step = 'food'; close(); }
    get('open-meal-entry').addEventListener('click', open);
    get('close-meal-entry').addEventListener('click', close);
    get('change-meal-food').addEventListener('click', () => { step = 'food'; paint(); focusStep(); });
    get('continue-custom-meal').addEventListener('click', () => {
        const food = onCustomContinue();
        if (food) select(food);
    });
    root.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
        view = button.dataset.view; editing = false; paint();
    }));
    root.querySelector('.wordmark').addEventListener('click', event => { event.preventDefault(); close(); });
    paint();
    return { open, close, select, reset };
}
