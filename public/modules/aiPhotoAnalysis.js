const GEMINI_API_KEY_STORAGE = 'nutritrack_gemini_api_key';

export function getGeminiApiKey() {
    return localStorage.getItem(GEMINI_API_KEY_STORAGE) || '';
}

export function saveGeminiApiKey(key) {
    localStorage.setItem(GEMINI_API_KEY_STORAGE, key.trim());
}

async function callGemini(apiKey, contents) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents })
        }
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Errore API Gemini (${res.status})`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const ANALYSIS_PROMPT = `Sei un nutrizionista AI esperto. Analizza questa foto di un pasto e stima i valori nutrizionali.

Rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo e senza blocchi markdown:
{
  "alimento": "nome del piatto o alimento",
  "quantita_stimata_g": 300,
  "valori_per_100g": {
    "calorie": 150,
    "proteine": 5.2,
    "carboidrati": 28.0,
    "grassi": 2.1,
    "fibre": 1.5
  },
  "confidenza": "alta",
  "domande_chiarimento": [],
  "note": ""
}

Regole importanti:
- Stima la quantità in grammi osservando le dimensioni visibili nel piatto
- "confidenza" può essere "alta", "media" o "bassa"
- Se sei incerto, inserisci massimo 2 domande brevi e specifiche in "domande_chiarimento"
- Se sei abbastanza sicuro, lascia "domande_chiarimento" come array vuoto []
- I valori nutrizionali devono essere per 100g di prodotto
- Rispondi sempre in italiano`;

export async function analyzePhoto(apiKey, imageBase64, mimeType) {
    const contents = [{
        parts: [
            { text: ANALYSIS_PROMPT },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
    }];
    return callGemini(apiKey, contents);
}

export async function refineWithAnswer(apiKey, imageBase64, mimeType, previousText, userAnswer) {
    const contents = [
        {
            parts: [
                { text: ANALYSIS_PROMPT },
                { inline_data: { mime_type: mimeType, data: imageBase64 } }
            ]
        },
        { role: 'model', parts: [{ text: previousText }] },
        {
            role: 'user',
            parts: [{
                text: `Risposta alle domande: ${userAnswer}\n\nFornisci la stima finale aggiornata. Rispondi SOLO con il JSON.`
            }]
        }
    ];
    return callGemini(apiKey, contents);
}

export function parseResponse(text) {
    const clean = text.trim();
    try { return JSON.parse(clean); } catch {}
    const blockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (blockMatch) { try { return JSON.parse(blockMatch[1].trim()); } catch {} }
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
    throw new Error('Risposta non valida da Gemini. Riprova.');
}
