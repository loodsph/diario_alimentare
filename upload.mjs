import { initializeApp } from 'firebase/app';
import { getFirestore, collection, writeBatch, getDocs, query, doc } from 'firebase/firestore';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

console.log(`
=======================================================================
⚠️  ATTENZIONE: Questo script cancellerà e sostituirà l'intera
    collezione 'foods' nel tuo database Firebase.

    Assicurati che le tue Regole di Sicurezza lo permettano
    temporaneamente (es. allow write: if true;).

    Ricorda di ripristinare regole sicure dopo l'esecuzione.
=======================================================================
`);

// --- CONFIGURAZIONE ---
const firebaseConfig = {
  apiKey: "AIzaSyCCwhGg3hSQauEXmA1YKMgH60JQk9VNvXA",
  authDomain: "diario-alimentare-4f07f.firebaseapp.com",
  projectId: "diario-alimentare-4f07f",
  storageBucket: "diario-alimentare-4f07f.appspot.com",
  messagingSenderId: "904900489529",
  appId: "1:904900489529:web:bb8d121f2a9a206c1538e8",
  measurementId: "G-JYDET1ZW5K"
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const inputFilePath = path.join(__dirname, 'dati_nutrizionali_test.json');
const collectionName = 'foods';

// Mappa per standardizzare i nomi dei nutrienti principali
const nutrientMap = {
    'Energia (kcal)': 'calories',
    'Proteine (g)': 'proteins',
    'Lipidi (g)': 'fats',
    'Carboidrati disponibili (g)': 'carbs',
    'Fibra totale (g)': 'fibers'
};

/**
 * Converte una chiave JSON in un nome di campo valido per Firestore.
 * @param {string} key - La chiave originale dal JSON.
 * @returns {string} La chiave convertita.
 */
function sanitizeNutrientKey(key) {
    return key.toLowerCase()
        .replace(/\s/g, '_')
        .replace(/[()]/g, '')
        .replace(/_μg/g, '_mcg');
}

/**
 * Converte un valore stringa in un numero, gestendo "tr" (traccia) e virgole.
 * @param {string | number} value - Il valore da convertire.
 * @returns {number} Il valore convertito o 0 se non valido.
 */
function parseNutrientValue(value) {
    if (typeof value !== 'string' || value.toLowerCase() === 'tr') {
        return 0;
    }
    const numericString = value.replace(',', '.');
    const parsedValue = parseFloat(numericString);
    return isNaN(parsedValue) ? 0 : parsedValue;
}

/**
 * Cancella tutti i documenti in una collezione.
 * @param {import("firebase/firestore").Firestore} db - L'istanza di Firestore.
 * @param {string} collectionPath - Il percorso della collezione da cancellare.
 */
async function deleteCollection(db, collectionPath) {
    const collectionRef = collection(db, collectionPath);
    const q = query(collectionRef);
    const snapshot = await getDocs(q);

    if (snapshot.size === 0) {
        console.log(`La collezione "${collectionPath}" è già vuota.`);
        return;
    }

    console.log(`Cancellazione di ${snapshot.size} documenti dalla collezione "${collectionPath}"...`);
    const batch = writeBatch(db);
    snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    console.log('Cancellazione completata.');
}

/**
 * Funzione principale per la sostituzione dei dati.
 */
async function replaceDatabase() {
    try {
        console.log('Inizializzazione di Firebase...');
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const foodsCollection = collection(db, collectionName);
        console.log('Firebase inizializzato.');

        await deleteCollection(db, collectionName);

        console.log(`Lettura del file di input: ${inputFilePath}`);
        const fileContent = await readFile(inputFilePath, 'utf-8');
        const sourceData = JSON.parse(fileContent);
        console.log(`Trovati ${sourceData.length} alimenti da importare.`);

        const batches = [];
        let currentBatch = writeBatch(db);
        let operationCount = 0;
        let importedCount = 0;

        sourceData.forEach(food => {
            const name = food.nome.trim();
            if (!name) return;

            const newFood = {};
            newFood.name = name;
            newFood.name_lowercase = name.toLowerCase();
            newFood.search_tokens = name.toLowerCase()
                .replace(/[.,/#!$%\^&*;:{}=\-_`~()']/g, "")
                .split(' ')
                .filter(token => token.length > 0);

            newFood.original_id = food.id;
            newFood.source_url = food.url;

            for (const [key, value] of Object.entries(food.nutrienti)) {
                if (key === "Descrizione Nutriente") continue;
                const newKey = nutrientMap[key] || sanitizeNutrientKey(key);
                newFood[newKey] = parseNutrientValue(value);
            }

            // Assicura che i campi standard esistano sempre
            Object.values(nutrientMap).forEach(standardKey => {
                if (!newFood.hasOwnProperty(standardKey)) {
                    newFood[standardKey] = 0;
                }
            });

            const newDocRef = doc(foodsCollection);
            currentBatch.set(newDocRef, newFood);
            operationCount++;
            importedCount++;

            // Suddivide in batch per non superare i limiti di Firestore
            if (operationCount >= 499) {
                batches.push(currentBatch);
                currentBatch = writeBatch(db);
                operationCount = 0;
            }
        });

        if (operationCount > 0) batches.push(currentBatch);

        if (batches.length > 0) {
            console.log(`\nInizio caricamento di ${importedCount} alimenti in ${batches.length} batch...`);
            for (let i = 0; i < batches.length; i++) {
                await batches[i].commit();
                console.log(`Batch ${i + 1}/${batches.length} caricato.`);
            }
            console.log('\nSostituzione del database completata con successo!');
        } else {
            console.log('Nessun alimento valido trovato nel file JSON da importare.');
        }
    } catch (error) {
        console.error("\nERRORE CRITICO:", error.message);
        console.error("Possibili cause: \n- Le Regole di Sicurezza di Firestore non permettono la scrittura.\n- La configurazione di Firebase non è corretta.\n- Il file JSON non è stato trovato o è malformato.");
    } finally {
        // Uscire dal processo per terminare l'esecuzione dello script
        process.exit(0);
    }
}

// Esegui lo script
replaceDatabase();
