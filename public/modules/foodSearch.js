// Logica di ricerca degli alimenti (pura, senza Firestore).

const DAY_MS = 24 * 60 * 60 * 1000;

// Token salvati in `search_tokens` per la ricerca per parola su Firestore.
export function searchTokens(name) {
    return name.toLowerCase().split(/[\s,.;:()_/-]+/).filter(token => token.length > 0);
}

// Termine di ricerca in minuscolo, senza spazi superflui.
export function normalizeQuery(searchTerm) {
    return searchTerm.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Parola da usare per la query `array-contains` su Firestore: la più lunga tra quelle complete.
// L'ultima parola si sta probabilmente ancora scrivendo, quindi si usa solo se è l'unica.
export function queryToken(searchTerm) {
    const terms = searchTokens(searchTerm);
    const complete = terms.length > 1 ? terms.slice(0, -1) : terms;
    return complete.reduce((longest, term) => term.length > longest.length ? term : longest, '');
}

function nameOf(item) {
    return item.name_lowercase || (item.name || '').toLowerCase();
}

// Score di pertinenza di un risultato rispetto al termine (già normalizzato).
// Con più parole, tutte devono comparire nel nome.
export function calculateSearchScore(item, searchTerm) {
    const nameLower = nameOf(item);
    const terms = searchTokens(searchTerm);
    if (terms.length === 0) return 0;
    if (nameLower === searchTerm) return 100; // Corrispondenza esatta
    if (nameLower.startsWith(searchTerm)) return 90; // Corrispondenza prefisso

    const tokens = item.search_tokens || searchTokens(nameLower);
    if (terms.every(term => tokens.includes(term))) return 80; // Tutte le parole intere
    if (terms.every(term => tokens.some(token => token.startsWith(term)))) return 75; // Inizi di parola
    if (terms.every(term => nameLower.includes(term))) return 70; // Contiene tutte le parti
    return 0; // Nessuna corrispondenza
}

// Frequenza e ultimo uso di ogni alimento/ricetta nei pasti registrati.
// Chiavi: id dell'alimento o della ricetta, e il nome (per i pasti senza id).
export function buildUsageStats(meals) {
    const stats = new Map();
    const record = (key, time) => {
        const stat = stats.get(key) || { count: 0, last: 0 };
        stat.count++;
        stat.last = Math.max(stat.last, time);
        stats.set(key, stat);
    };
    meals.forEach(meal => {
        const time = meal.jsDate ? meal.jsDate.getTime() : 0;
        const id = meal.recipeId || meal.foodId;
        if (id) record(id, time);
        if (meal.name) record(`name:${meal.name.toLowerCase()}`, time);
    });
    return stats;
}

// Bonus (0-30) per gli alimenti usati spesso e di recente: fino a 20 per la frequenza, 10 per la recenza.
export function usageBoost(item, usage, now = Date.now()) {
    const stat = (item.id && usage.get(item.id)) || usage.get(`name:${nameOf(item)}`);
    if (!stat) return 0;
    const daysAgo = (now - stat.last) / DAY_MS;
    return Math.min(stat.count, 10) * 2 + Math.max(0, 1 - daysAgo / 30) * 10;
}

// Ordina in base a pertinenza e uso personale, poi alfabeticamente (modifica l'array).
export function sortResults(results, searchTerm, usage = new Map(), now = Date.now()) {
    const rank = item => {
        const score = calculateSearchScore(item, searchTerm);
        return score > 0 ? score + usageBoost(item, usage, now) : 0;
    };
    const ranks = new Map(results.map(item => [item, rank(item)]));
    return results.sort((a, b) => ranks.get(b) - ranks.get(a) || a.name.localeCompare(b.name));
}

// Corrispondenza lato client: ogni parola del termine deve comparire nel nome.
export function matchesSearch(item, searchTerm) {
    const nameLower = nameOf(item);
    const terms = searchTokens(searchTerm);
    return terms.length > 0 && terms.every(term => nameLower.includes(term));
}
