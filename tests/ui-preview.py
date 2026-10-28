"""Build an isolated UI preview with production markup/controllers and in-memory data.
Usage: python3 tests/ui-preview.py [--serve] (localhost:8765).
Only explicitly public assets are copied; no Firebase config or project secrets are served.
"""
from pathlib import Path
import re
import shutil
import tempfile
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

repo = Path(__file__).resolve().parents[1]
out = Path(tempfile.mkdtemp(prefix='nutritrack-ui-'))
for name in ['style.css', 'manifest.json']:
    shutil.copy(repo / 'public' / name, out / name)
shutil.copytree(repo / 'public/modules', out / 'modules')
if '--mock-dish-ai' in sys.argv:
    # Only the isolated preview is modified. No API key or network request is used.
    module = out / 'modules/aiDishAnalysis.js'
    module.write_text('''
const fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    name: 'Polpette di esempio', values: { calories: 220, proteins: 20, carbs: 8, fats: 12, fibers: 1 },
    assumptions: ['Dati sintetici per verificare il form: non sono una stima nutrizionale.', 'Esempio di preparazione al forno con olio incluso.'], notes: 'Anteprima: nessuna chiamata a Gemini.'
}) }] } }] }) });
''' + module.read_text())
html = (repo / 'public/index.html').read_text()
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
html = html.replace('</body>', '<script type="module" src="preview.js"></script></body>')
html = html.replace('<body class="nutritrack">', '<body class="nutritrack"><p style="text-align:center;padding:8px;font-size:11px">Anteprima locale · dati di esempio · nessun salvataggio online</p>')
if '--mock-dish-ai' in sys.argv:
    html = html.replace('</head>', '<meta name="dish-ai-preview" content="mock"></head>')
    html = html.replace('nessun salvataggio online</p>', 'nessun salvataggio online · Gemini simulato (usa una chiave fittizia)</p>')
(out / 'index.html').write_text(html)
light_tokens = re.search(r':root \{(.*?)\}', (repo / 'public/input.css').read_text(), re.S).group(1)
(out / 'light.html').write_text(html.replace('</head>', '<style>:root {' + light_tokens + 'color-scheme: light;}</style></head>'))
source = (repo / 'public/script.js').read_text()
source = re.sub(r'^import .*?(?:https://|firebase-config).*?;\n', '', source, flags=re.M)
start = source.index("window.addEventListener('DOMContentLoaded', () => {")
end = source.index('// --- GESTIONE EVENTI ---', start)
source = source[:start] + source[end:]
source += '''
// Test-only substitutes. All diary writes stay in this page's memory.
const memory = new Map();
const watchers = new Set();
const pending = new Set();
const acknowledgements = [];
let nextId = 0;
const collection = (_db, path) => ({ path, collection: true });
const doc = (parent, path, id) => ({ path: id ? `${path}/${id}` : path ? path : `${parent.path}/preview-${++nextId}` });
const query = (ref, ...constraints) => ({ ...ref, constraints });
const where = (field, op, value) => ({ field, op, value });
const documentId = () => '__name__';
const orderBy = () => ({});
const limit = () => ({});
const Timestamp = { fromDate: value => value, now: () => new Date() };
function snapshot(ref) {
    const entries = [...memory].filter(([path, data]) => {
        if (!ref.collection) return path === ref.path;
        if (path.slice(0, path.lastIndexOf('/')) !== ref.path) return false;
        return (ref.constraints || []).every(({field, op, value}) => {
            if (!field) return true;
            const actual = field === '__name__' ? path.split('/').at(-1) : data[field];
            return op === '>=' ? actual >= value : op === '<=' ? actual <= value : op === '==' ? actual === value : true;
        });
    }).map(([path, data]) => ({ id: path.split('/').at(-1), metadata: { hasPendingWrites: pending.has(path) }, data: () => ({...data, ...(data.date ? { date: { toDate: () => new Date(data.date) } } : {})}) }));
    const metadata = { fromCache: !isOnline, hasPendingWrites: entries.some(entry => entry.metadata.hasPendingWrites) };
    return ref.collection ? { docs: entries, metadata, empty: !entries.length, forEach: fn => entries.forEach(fn) } : { ...entries[0], metadata, data: () => entries[0]?.data() };
}
function emit() { watchers.forEach(watcher => watcher.callback(snapshot(watcher.ref))); }
const onSnapshot = (ref, options, callback) => {
    const watcher = { ref, callback: typeof options === 'function' ? options : callback };
    watchers.add(watcher); queueMicrotask(() => { if (watchers.has(watcher)) watcher.callback(snapshot(ref)); });
    return () => watchers.delete(watcher);
};
const getDocs = async ref => snapshot(ref);
const getDoc = async ref => snapshot(ref);
function mutate(ref, data, remove = false) {
    if (!ref.path.startsWith(`users/${userId}/`)) throw new Error('Solo dati di anteprima');
    if (remove) memory.delete(ref.path); else memory.set(ref.path, { ...memory.get(ref.path), ...data });
    pending.add(ref.path); emit();
    return new Promise(resolve => {
        const ack = () => { pending.delete(ref.path); emit(); resolve(); };
        if (isOnline) queueMicrotask(ack); else acknowledgements.push(ack);
    });
}
const setDoc = (ref, data) => mutate(ref, data);
const updateDoc = (ref, data) => mutate(ref, data);
const deleteDoc = ref => mutate(ref, null, true);
const addDoc = (ref, data) => setDoc(doc(ref), data);
const writeBatch = () => {
    const entries = [];
    return { set(ref, data) { entries.push({ ref, data }); }, commit: () => Promise.all(entries.map(entry => setDoc(entry.ref, entry.data))) };
};
fetchFoodMatches = async term => new Map(foods.filter(food => food.name.toLowerCase().includes(term)).map(food => [food.id, food]));
userId = 'local-ui-preview';
foods = [
 { id: 'yogurt', name: 'Yogurt bianco', calories: 60, proteins: 4, carbs: 5, fats: 3, servingGrams: 125, servingLabel: 'Vasetti', packageGrams: 125 },
 { id: 'pane', name: 'Pane integrale', calories: 250, proteins: 9, carbs: 45, fats: 3, fibers: 6 },
 { id: 'pasta', name: 'Pasta al pomodoro', calories: 150, proteins: 5, carbs: 28, fats: 2 }
];
recipes = [{ id: 'recipe', name: 'Zuppa di verdure', ingredients: [], isRecipe: true, servings: 4, finalWeight: 1000, totalWeight: 800, totalNutrition: { calories: 600, proteins: 20, carbs: 100, fats: 14, fibers: 16 } }];
allMeals = [
 { ...foods[0], id: 'meal-1', type: '🌅 Colazione', quantity: 125, jsDate: selectedDate, portion: { unitId: 'serving', label: 'Vasetti', amount: 1, gramsPerUnit: 125 } },
 { ...foods[1], id: 'meal-2', type: '🌅 Colazione', quantity: 60, jsDate: selectedDate, portion: { unitId: 'custom', label: 'Fette', amount: 2, gramsPerUnit: 30 } },
 { ...foods[2], id: 'meal-3', type: '🍽️ Pranzo', quantity: 250, jsDate: selectedDate }
];
for (const meal of allMeals) memory.set(`users/${userId}/meals/${meal.id}`, { ...meal, date: meal.jsDate });
const yesterday = new Date(selectedDate); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
memory.set(`users/${userId}/meals/yesterday`, { ...allMeals[0], date: yesterday });
const older = new Date(selectedDate); older.setUTCDate(older.getUTCDate() - 60);
memory.set(`users/${userId}/meals/older`, { ...allMeals[1], name: 'Pasto storico di prova', date: older });
setupListeners(); listenToMeals(); listenToWaterData(); listenToHabitualMeals(); recalculateDailyTotals(); updateAllUI(); renderRecipes(); renderWaterTracker(); initializeMealTypeByTime();
document.getElementById('app').classList.remove('hidden');
document.getElementById('top-bar').classList.remove('hidden');
document.getElementById('user-info').classList.add('hidden');
document.getElementById('loading-overlay').classList.add('hidden');
document.getElementById('logout-btn').disabled = true;
const toggle = document.createElement('button'); toggle.className = 'text-button'; toggle.textContent = 'Anteprima: passa offline';
toggle.addEventListener('click', () => {
    updateOnlineStatus(!isOnline);
    toggle.textContent = isOnline ? 'Anteprima: passa offline' : 'Anteprima: torna online';
    if (isOnline) acknowledgements.splice(0).forEach(ack => ack());
    emit();
});
document.querySelector('.sync-strip').append(toggle);
'''
(out / 'preview.js').write_text(source)
print(out, flush=True)
if '--serve' in sys.argv:
    ThreadingHTTPServer(('127.0.0.1', 8765), partial(SimpleHTTPRequestHandler, directory=str(out))).serve_forever()
