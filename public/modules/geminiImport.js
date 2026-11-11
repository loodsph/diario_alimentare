// Values describe ONE eaten portion. The legacy diary multiplier is quantity / 100:
// quantity=100 is an accounting unit here, never a measured or estimated weight.
export const GEMINI_INSTRUCTIONS = `Sei l'assistente di NutriTrack per stimare i nutrienti di un pasto da una foto, una descrizione o entrambe.

OBIETTIVO
Restituisci i valori TOTALI della porzione che ho effettivamente mangiato, mai per 100 g. Una porzione può comprendere più alimenti. Non assumere che abbia mangiato tutto ciò che compare nella foto o tutta una ricetta.

PRIMA DEL RISULTATO
Se mancano informazioni che cambiano sensibilmente la stima, fammi fino a tre domande mirate per volta: quantità o frazione mangiata, dimensioni/numero dei pezzi, ingredienti, condimenti, cottura, peso crudo o cotto. Chiedi solo ciò che serve e attendi la risposta. Non pretendere una bilancia: accetta pezzi, misure domestiche e confronti visivi. Se non so rispondere, usa ipotesi ragionevoli e dichiarale nella riga Note.

CALCOLO
Usa le etichette che fornisco quando sono leggibili; altrimenti stima con dati alimentari pertinenti. Distingui crudo/cotto ed escludi ossa, scarti e avanzi. Considera olio, salse e bevande solo una volta. Non inventare un peso esatto da una fotografia. Somma tutti gli alimenti della sola porzione mangiata. Controlla la coerenza delle kcal con i nutrienti, tenendo conto di fibre, alcol e arrotondamenti; non modificare automaticamente le calorie di un'etichetta per farle coincidere con una formula. Sono stime alimentari, non indicazioni mediche o obiettivi dietetici.

FORMATO FINALE
Quando hai abbastanza informazioni, rispondi solo con un unico blocco di testo copiabile nel formato seguente (i numeri sono solo un esempio):
Nome: Pollo con riso
P: 25
C: 12
G: 2
kcal: 166
F: 1
Note: Valori per tutta la porzione mangiata; quantità stimate dalla foto.

P = proteine in grammi, C = carboidrati in grammi, G = grassi in grammi, kcal = energia in chilocalorie, F = fibre in grammi. P, C, G e kcal sono obbligatori. Usa numeri non negativi, senza separatori delle migliaia, con al massimo un decimale. Non usare intervalli, simboli circa, alternative, tabelle o testo fuori dal blocco. Nome deve essere breve (massimo 200 caratteri). Note è una sola riga (massimo 1000 caratteri) con le principali ipotesi e incertezze. Includi F se riesci a stimare le fibre; se non sono disponibili ometti F, senza trasformare un dato sconosciuto in zero. Non includere mai dati per 100 g in questo blocco. Dopo una mia correzione ricalcola e restituisci un nuovo blocco completo, non solo le differenze.`;

const keys = { p: 'proteins', c: 'carbs', g: 'fats', kcal: 'calories', kal: 'calories', f: 'fibers', nome: 'name', note: 'notes' };
export const importNutrientLabels = { calories: 'Energia (kcal)', proteins: 'Proteine (g)', carbs: 'Carboidrati (g)', fats: 'Grassi (g)', fibers: 'Fibre (g)' };

function numeric(value, label, optional = false) {
    if (optional && (value == null || String(value).trim() === '')) return null;
    const text = String(value ?? '').trim();
    if (!/^\d+(?:[.,]\d+)?$/.test(text)) throw new Error(`${label}: inserisci un numero non negativo, senza separatori delle migliaia.`);
    const number = Number(text.replace(',', '.'));
    if (!Number.isFinite(number) || number > 100000) throw new Error(`${label}: valore troppo grande.`);
    return number;
}

export function validateImportedValues(values) {
    return Object.fromEntries(Object.entries(importNutrientLabels).map(([key, label]) => [key, numeric(values[key], label, key === 'fibers')]));
}

export function parseGeminiText(raw) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Incolla il risultato di Gemini.');
    if (raw.length > 6000) throw new Error('Il testo è troppo lungo. Incolla solo il blocco con i valori del pasto.');
    const text = raw.trim().replace(/^```(?:text|plaintext)?\s*\n([\s\S]*?)\n```$/i, '$1');
    const seen = new Set(), values = {};
    let name = '', notes = '';
    for (const line of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        const match = line.match(/^([a-z]+)\s*:\s*(.*?)\s*$/i);
        if (!match) throw new Error('Usa una riga per valore: P: 25, C: 12, G: 2, kcal: 166.');
        const label = match[1].toLowerCase();
        const key = Object.hasOwn(keys, label) ? keys[label] : null;
        if (!key) throw new Error(`Campo “${match[1]}” non riconosciuto. Incolla solo Nome, P, C, G, kcal, F e Note.`);
        if (seen.has(key)) throw new Error(`Campo “${match[1]}” ripetuto. Importa una sola porzione alla volta.`);
        seen.add(key);
        if (key === 'name') name = match[2];
        else if (key === 'notes') notes = match[2];
        else {
            const unit = key === 'calories' ? /\s*kcal$/i : /\s*g$/i;
            values[key] = numeric(match[2].replace(unit, ''), match[1]);
        }
    }
    const missing = [['proteins', 'P'], ['carbs', 'C'], ['fats', 'G'], ['calories', 'kcal']].filter(([key]) => !seen.has(key));
    if (missing.length) throw new Error(`Mancano i valori obbligatori: ${missing.map(([, label]) => label).join(', ')}.`);
    if (name.length > 200 || notes.length > 1000) throw new Error('Nome o note troppo lunghi. Usa un nome breve e una sola riga di note.');
    return { name, notes, values: validateImportedValues(values) };
}

export function importedPortionToFood(parsed, name, correctedValues = parsed.values) {
    name = String(name || '').trim();
    if (!name || name.length > 200) throw new Error('Inserisci un nome del pasto (massimo 200 caratteri).');
    const values = validateImportedValues(correctedValues);
    return {
        name, ...values, fibers: values.fibers ?? 0, quantity: 100, estimated: true,
        portion: { unitId: 'portion', label: 'Porzione descritta', amount: 1, gramsPerUnit: 100, weightUnknown: true, source: 'Valori importati da Gemini' },
        importedEstimate: {
            version: 1, source: 'gemini', basis: 'portion', originalValues: parsed.values,
            notes: parsed.notes, fibersKnown: values.fibers !== null,
            edited: name !== parsed.name || Object.keys(values).some(key => values[key] !== parsed.values[key])
        }
    };
}
