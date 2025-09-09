const fs = require('fs');
const path = require('path');

// --- CONFIGURAZIONE ---
const inputFilePath = path.join(__dirname, 'dati_nutrizionali_test.json');
const outputFilePath = path.join(__dirname, 'dati_trasformati.json');

// Mappa per standardizzare i nomi dei nutrienti principali
const nutrientMap = {
    'Energia (kcal)': 'calories',
    'Proteine (g)': 'proteins',
    'Lipidi (g)': 'fats',
    'Carboidrati disponibili (g)': 'carbs',
    'Fibra totale (g)': 'fibers'
};

/**
 * Pulisce e converte una chiave di un nutriente in un formato standard.
 * Esempio: "Vitamina C (mg)" -> "vitamina_c_mg"
 * @param {string} key - La chiave originale.
 * @returns {string} La chiave pulita.
 */
function sanitizeNutrientKey(key) {
    return key.toLowerCase()
        .replace(/\s/g, '_') // Sostituisce spazi con underscore
        .replace(/[()]/g, '') // Rimuove parentesi
        .replace(/_μg/g, '_mcg'); // Standardizza microgrammi
}

/**
 * Converte un valore stringa in numero, gestendo casi particolari.
 * @param {string} value - Il valore da convertire.
 * @returns {number} Il valore numerico (0 se non valido).
 */
function parseNutrientValue(value) {
    if (typeof value !== 'string') {
        return 0;
    }
    // Sostituisce la virgola con il punto per i decimali
    const numericString = value.replace(',', '.');
    const parsedValue = parseFloat(numericString);
    // Se il valore non è un numero (es. "tr" per tracce), restituisce 0
    return isNaN(parsedValue) ? 0 : parsedValue;
}

/**
 * Funzione principale che trasforma i dati.
 */
function transformData() {
    console.log(`Lettura del file di input: ${inputFilePath}`);
    
    let sourceData;
    try {
        const fileContent = fs.readFileSync(inputFilePath, 'utf-8');
        sourceData = JSON.parse(fileContent);
    } catch (error) {
        console.error(`Errore durante la lettura o il parsing del file JSON: ${error.message}`);
        return;
    }

    console.log(`Trovati ${sourceData.length} alimenti da trasformare.`);

    const transformedData = sourceData.map(food => {
        const newFood = {};

        // 1. Campi base e di ricerca
        newFood.name = food.nome.trim();
        newFood.name_lowercase = food.nome.trim().toLowerCase();
        newFood.search_tokens = food.nome.toLowerCase()
            .replace(/[.,/#!$%\^&*;:{}=\-_`~()]/g, "") // Rimuove punteggiatura
            .split(' ')
            .filter(token => token.length > 0); // Rimuove token vuoti

        // 2. Campi opzionali ma utili
        newFood.original_id = food.id;
        newFood.source_url = food.url;

        // 3. Appiattimento e standardizzazione dei nutrienti
        for (const [key, value] of Object.entries(food.nutrienti)) {
            // Salta la riga di descrizione
            if (key === "Descrizione Nutriente") continue;

            // Usa la mappa per i nomi standard o sanifica la chiave
            const newKey = nutrientMap[key] || sanitizeNutrientKey(key);
            const parsedValue = parseNutrientValue(value);

            newFood[newKey] = parsedValue;
        }
        
        // Assicura che i campi principali esistano, anche se a 0
        Object.values(nutrientMap).forEach(standardKey => {
            if (!newFood.hasOwnProperty(standardKey)) {
                newFood[standardKey] = 0;
            }
        });

        return newFood;
    });

    try {
        fs.writeFileSync(outputFilePath, JSON.stringify(transformedData, null, 2));
        console.log(`\nTrasformazione completata con successo!`);
        console.log(`I dati sono stati salvati in: ${outputFilePath}`);
    } catch (error) {
        console.error(`Errore durante la scrittura del file di output: ${error.message}`);
    }
}

// Esegui lo script
transformData();
