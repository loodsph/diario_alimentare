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
html = (repo / 'public/index.html').read_text()
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
html = html.replace('</body>', '<script type="module" src="preview.js"></script></body>')
html = html.replace('<body class="nutritrack">', '<body class="nutritrack"><p style="text-align:center;padding:8px;font-size:11px">Anteprima locale · dati di esempio · nessun salvataggio online</p>')
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
const collection = (_db, path) => path;
const query = (...args) => args;
const where = (...args) => args;
const Timestamp = { fromDate: value => value };
const getDocs = async () => ({ docs: [], empty: true });
const addDoc = async (path, data) => {
    if (!path.endsWith('/meals')) throw new Error('Operazione non disponibile in anteprima');
    allMeals.push({ ...data, id: `preview-${allMeals.length}`, jsDate: data.date });
    dailyMealsCache = {}; recalculateDailyTotals(); updateAllUI();
};
searchFoodsAndRecipes = async term => foods.filter(food => food.name.toLowerCase().includes(term));
searchFoodsOnly = searchFoodsAndRecipes;
listenToWaterData = () => renderWaterTracker();
setWaterCount = async count => { waterCount = Math.max(0, count); renderWaterTracker(); };
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
setupListeners(); recalculateDailyTotals(); updateAllUI(); renderRecipes(); renderWaterTracker(); initializeMealTypeByTime();
document.getElementById('app').classList.remove('hidden');
document.getElementById('top-bar').classList.remove('hidden');
document.getElementById('user-info').classList.add('hidden');
document.getElementById('loading-overlay').classList.add('hidden');
document.getElementById('logout-btn').disabled = true;
'''
(out / 'preview.js').write_text(source)
print(out, flush=True)
if '--serve' in sys.argv:
    ThreadingHTTPServer(('127.0.0.1', 8765), partial(SimpleHTTPRequestHandler, directory=str(out))).serve_forever()
