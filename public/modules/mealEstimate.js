import { nutrientKeys, formatAmount, positive } from './portions.js?v=20261025';

// These are starting assumptions, not standard portion sizes or restaurant-specific data.
// Per-100-g references and explicit model assumptions are shown in the editor.
const crea = code => `https://www.alimentinutrizione.it/tabelle-nutrizionali/${code}`;
const sushi = slug => `https://sushigourmet.eu/en/produit/${slug}/`;
const model = 'Modello indicativo NutriTrack: ricetta e dimensioni possono variare.';
function item(id, group, name, unit, grams, values, note = model, source = '') {
    return { id, group, name, unit, grams, ...Object.fromEntries(nutrientKeys.map((key, i) => [key, values[i] || 0])), note, source };
}
export const estimateCatalog = [
    item('sausage', 'grill', 'Salsiccia', 'pezzi', 80, [324, 22.2, 0, 26.1], 'Riferimento CREA: salsiccia cotta in padella, usata come approssimazione della griglia.', crea('110716')),
    item('ribs', 'grill', 'Costina di maiale', 'pezzi', 45, [290, 25, 0, 21], 'Modello NutriTrack per costina cotta: 45 g di carne per pezzo, osso escluso.'),
    item('steak', 'grill', 'Bistecca di manzo', 'pezzi', 180, [240, 27, 0, 14.7], 'Modello NutriTrack per bistecca cotta con parte del grasso: 180 g edibili, osso escluso.'),
    item('chicken', 'grill', 'Petto di pollo', 'pezzi', 120, [129, 30.2, 0, 0.9], 'Riferimento CREA: petto cotto in padella senza grassi aggiunti. Aggiungi a parte l’olio consumato.', crea('106506')),
    item('burger', 'grill', 'Hamburger di manzo', 'pezzi', 100, [250, 26, 0, 16.2], 'Modello NutriTrack per sola carne cotta. Pane e salse da aggiungere a parte.'),
    item('nigiri', 'sushi', 'Nigiri al salmone', 'pezzi', 30, [201.3, 10, 24.8, 6.9], 'Riferimento Sushi Gourmet per 100 g; 30 g per pezzo è un’ipotesi NutriTrack.', sushi('salmon-nigiri-sushi')),
    item('maki', 'sushi', 'Hosomaki al salmone', 'pezzi', 20, [160, 8, 26, 2.7]),
    item('uramaki', 'sushi', 'Uramaki salmone e avocado', 'pezzi', 35, [190, 7, 28, 5.6]),
    item('rich-roll', 'sushi', 'Roll fritto / con maionese', 'pezzi', 40, [280, 7, 32, 13.8], 'Modello NutriTrack: frittura e salsa già incluse. Aggiungi solo eventuale salsa extra.'),
    item('sashimi', 'sushi', 'Sashimi misto salmone e tonno', 'fette', 20, [162.4, 22.2, 0, 8.2], 'Riferimento Sushi Gourmet per 100 g; 20 g per fetta è un’ipotesi NutriTrack.', sushi('tuna-salmon-sashimi')),
    item('bread', 'extra', 'Pane', 'fette', 30, [270, 8, 55, 1.5, 3]),
    item('vegetables', 'extra', 'Verdure grigliate senza olio', 'porzioni', 150, [35, 1.5, 5, 0.5, 2]),
    item('potatoes', 'extra', 'Patate al forno', 'porzioni', 150, [150, 2.5, 23, 5, 2]),
    item('oil', 'extra', 'Olio consumato', 'cucchiai', 10, [900, 0, 0, 100]),
    item('mayo', 'extra', 'Maionese extra', 'cucchiai', 15, [680, 1, 2, 74]),
    item('bbq', 'extra', 'Salsa barbecue', 'cucchiai', 15, [150, 1, 35, 0.5]),
    item('soy', 'extra', 'Salsa di soia', 'cucchiai', 15, [55, 8, 5, 0]),
    item('beer', 'extra', 'Birra (330 ml)', 'bottiglie', 330, [43, 0.5, 3.5, 0], 'Modello NutriTrack: bottiglia da 330 ml, massa approssimata a 330 g. Le calorie includono l’alcol.'),
    item('wine', 'extra', 'Vino (125 ml)', 'bicchieri', 125, [85, 0, 2.5, 0], 'Modello NutriTrack: bicchiere da 125 ml, massa approssimata a 125 g. Le calorie includono l’alcol.'),
    item('cola', 'extra', 'Bibita zuccherata (330 ml)', 'lattine', 340, [41, 0, 10.3, 0], 'Modello NutriTrack: lattina da 330 ml, massa approssimata a 340 g.')
];
export function estimateRow(id) {
    const entry = estimateCatalog.find(item => item.id === id);
    if (!entry) throw new Error('Alimento non disponibile.');
    return { ...entry, count: 1 };
}
export function buildMealEstimate(kind, rows) {
    if (!['grill', 'sushi'].includes(kind)) throw new Error('Scegli grigliata o sushi.');
    if (!rows.length || rows.length > 30) throw new Error('Aggiungi da 1 a 30 alimenti.');
    const totals = Object.fromEntries(nutrientKeys.map(key => [key, 0]));
    let grams = 0;
    const items = rows.map(row => {
        if (!estimateCatalog.some(item => item.id === row.id) || !positive(row.count) || !positive(row.grams)
            || Number(row.count) > 10000 || Number(row.grams) > 10000
            || nutrientKeys.some(key => row[key] === '' || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0 || Number(row[key]) > 1000)) {
            throw new Error('Controlla quantità, peso e valori nutrizionali: non lasciare campi vuoti o negativi.');
        }
        const weight = Number(row.count) * Number(row.grams);
        grams += weight;
        nutrientKeys.forEach(key => { totals[key] += Number(row[key]) * weight / 100; });
        return { ...row, count: Number(row.count), grams: Number(row.grams) };
    });
    const nutrition = Object.fromEntries(nutrientKeys.map(key => [key, totals[key] * 100 / grams]));
    // A transparent heuristic, not a statistical confidence interval. Persist the method/version.
    const margin = kind === 'sushi' ? 0.35 : 0.3;
    const label = kind === 'sushi' ? 'Sushi' : 'Grigliata';
    return {
        name: `${label} · pasto stimato`, ...nutrition, estimated: true,
        quantity: grams, servingGrams: grams, servingLabel: 'Pasto stimato',
        portion: { unitId: 'serving', label: 'Pasto stimato', amount: 1, gramsPerUnit: grams, source: 'Stima in pezzi', ingredientWeight: false },
        estimate: { version: 1, kind, baseGrams: grams, items, margin,
            rangePer100g: { min: nutrition.calories * (1 - margin), max: nutrition.calories * (1 + margin) } }
    };
}
export function estimateLabel(food) {
    return food?.aiEstimate ? 'Stima da descrizione' : food?.estimate ? 'Stima in pezzi' : food?.estimated ? 'Stima da foto' : '';
}
export function estimateRange(food, quantity = food.quantity) {
    const range = food?.estimate?.rangePer100g;
    if (!range || !positive(quantity)) return '';
    return `Intervallo indicativo: ${Math.round(range.min * quantity / 100)}–${Math.round(range.max * quantity / 100)} kcal`;
}
export function estimateBreakdown(food, quantity = food.quantity) {
    const estimate = food?.estimate;
    if (!estimate || !positive(estimate.baseGrams) || !positive(quantity)) return '';
    const factor = quantity / estimate.baseGrams;
    return estimate.items.map(item => `${formatAmount(item.count * factor)} ${item.unit} di ${item.name} (${formatAmount(item.count * factor * item.grams)} g)`).join(' · ');
}
