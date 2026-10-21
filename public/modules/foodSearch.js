// Logica di ricerca degli alimenti (pura, senza Firestore).

// Token salvati in `search_tokens` per la ricerca per parola su Firestore.
export function searchTokens(name) {
    return name.toLowerCase().split(/[\s,.;:()_/-]+/).filter(token => token.length > 0);
}

// Score di pertinenza di un risultato rispetto al termine (già in minuscolo).
export function calculateSearchScore(item, searchTerm) {
    const nameLower = item.name_lowercase || '';
    if (nameLower === searchTerm) return 100; // Corrispondenza esatta
    if (nameLower.startsWith(searchTerm)) return 90; // Corrispondenza prefisso

    const terms = searchTerm.split(' ').filter(t => t.length > 0);
    if (terms.some(term => (item.search_tokens || []).includes(term))) return 80; // Corrispondenza token

    if (nameLower.includes(searchTerm)) return 70; // Contiene la stringa
    return 0; // Nessuna corrispondenza forte
}

// Ordina in base allo score e poi alfabeticamente (modifica l'array).
export function sortResults(results, searchTerm) {
    return results.sort((a, b) => calculateSearchScore(b, searchTerm) - calculateSearchScore(a, searchTerm) || a.name.localeCompare(b.name));
}

// Corrispondenza parziale lato client, per gli elementi già in cache.
export function matchesSearch(item, searchTerm) {
    const terms = searchTerm.split(' ').filter(t => t.length > 0);
    const itemTokens = item.search_tokens || [];
    return (item.name_lowercase || '').includes(searchTerm) || terms.some(term => itemTokens.includes(term));
}
