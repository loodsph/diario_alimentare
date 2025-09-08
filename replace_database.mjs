// replace_database.mjs
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, writeBatch, getDocs, query, deleteDoc, doc } from 'firebase/firestore';
import { readFile } from 'fs/promises';

// --- CONFIGURAZIONE ---
// Incolla qui la tua configurazione di Firebase, la stessa che usi in script.js
const firebaseConfig = {
  apiKey: "AIzaSyCCwhGg3hSQauEXmA1YKMgH60JQk9VNvXA",
  authDomain: "diario-alimentare-4f07f.firebaseapp.com",
  projectId: "diario-alimentare-4f07f",
  storageBucket: "diario-alimentare-4f07f.appspot.com",
  messagingSenderId: "904900489529",
  appId: "1:904900489529:web:bb8d121f2a9a206c1538e8",
  measurementId: "G-JYDET1ZW5K"
};

// --- FUNZIONI DELLO SCRIPT ---

/**
 * Converte un valore stringa in un numero, gestendo "tr" (traccia) e virgole.
 * @param {string | number} value - Il valore da convertire.
 * @returns {number} Il valore convertito o 0 se non valido.
 */
function parseNutrientValue(value) {
    if (typeof value !== 'string' || value.toLowerCase() === 'tr') {
        return 0;
    }
    const numericValue = parseFloat(value.replace(',', '.'));
    return isNaN(numericValue) ? 0 : numericValue;
}

/**
 * Converte una chiave JSON in un nome di campo valido per Firestore.
 * Es: "Energia (kcal)" -> "energia_kcal"
 * @param {string} key - La chiave originale dal JSON.
 * @returns {string} La chiave convertita.
 */
function sanitizeFieldName(key) {
    // FIX: Regex corretta per rimuovere le unità di misura tra parentesi.
    return key
        .toLowerCase()
        .replace(/\s\(.*\)/, '') // Rimuove lo spazio e tutto ciò che è tra parentesi (es. " (g)")
        .replace(/[^a-z0-9]/g, '_') // Sostituisce i caratteri non alfanumerici con _
        .replace(/_+/g, '_') // Rimuove eventuali underscore doppi
        .replace(/_$/, ''); // Rimuove l'underscore finale se presente
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
async function replaceData() {
    try {
        // 1. Inizializza Firebase
        console.log('Inizializzazione di Firebase...');
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const foodsCollection = collection(db, 'foods');
        console.log('Firebase inizializzato.');

        // 2. CANCELLA TUTTI I DATI ESISTENTI
        await deleteCollection(db, 'foods');

        // 3. Leggi e analizza il nuovo file JSON
        console.log('Lettura del file JSON...');
        const jsonPath = new URL('./dati_nutrizionali_test.json', import.meta.url);
        const fileContent = await readFile(jsonPath, 'utf-8');
        const foodsToImport = JSON.parse(fileContent);
        console.log(`Trovati ${foodsToImport.length} alimenti da importare.`);
        
        // 4. Prepara i batch per scrivere i nuovi dati
        const batches = [];
        let currentBatch = writeBatch(db);
        let operationCount = 0;
        let importedCount = 0;

        foodsToImport.forEach(food => {
            const name = food.nome.trim();
            if (!name) return; // Salta alimenti senza nome

            let newFoodData = {
                name: name,
                name_lowercase: name.toLowerCase(),
                original_id: food.id,
                source_url: food.url
            };

            for (const [key, value] of Object.entries(food.nutrienti)) {
                const numericValue = parseNutrientValue(value);
                if (!isNaN(numericValue) && key !== 'Descrizione Nutriente') {
                    const fieldName = sanitizeFieldName(key);
                    newFoodData[fieldName] = numericValue;
                }
            }

            // --- FIX CRUCIALE ---
            // Aggiunge i campi "base" per compatibilità con l'app, usando i nuovi campi come fonte.
            newFoodData.calories = newFoodData.energia || 0;
            newFoodData.proteins = newFoodData.proteine || 0;
            newFoodData.carbs = newFoodData.carboidrati_disponibili || 0;
            newFoodData.fats = newFoodData.lipidi || 0;
            newFoodData.fibers = newFoodData.fibra_alimentare_solubile_in_acqua_e_insolubile || newFoodData.fibra_totale || 0;

            const newFoodRef = doc(foodsCollection);
            currentBatch.set(newFoodRef, newFoodData);
            operationCount++;
            importedCount++;

            if (operationCount >= 499) {
                batches.push(currentBatch);
                currentBatch = writeBatch(db);
                operationCount = 0;
            }
        });

        if (operationCount > 0) batches.push(currentBatch);

        if (importedCount > 0) {
            console.log(`Importazione di ${importedCount} nuovi alimenti nel database in ${batches.length} batch...`);
            for (let i = 0; i < batches.length; i++) {
                console.log(`Esecuzione batch ${i + 1} di ${batches.length}...`);
                await batches[i].commit();
            }
            console.log('Sostituzione del database completata con successo!');
        } else {
            console.log('Nessun alimento valido trovato nel file JSON da importare.');
        }
    } catch (error) {
        console.error("Errore durante la sostituzione del database:", error);
    } finally {
        process.exit(0);
    }
}

replaceData();