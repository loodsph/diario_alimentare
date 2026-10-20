const GEMINI_API_KEY_STORAGE = 'nutritrack_gemini_api_key';

export function getGeminiApiKey() {
    return localStorage.getItem(GEMINI_API_KEY_STORAGE) || '';
}

export function saveGeminiApiKey(key) {
    localStorage.setItem(GEMINI_API_KEY_STORAGE, key.trim());
}

async function callGemini(apiKey, contents) {
    const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({ contents, generationConfig: { responseMimeType: 'application/json' } })
        }
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const status = res.status;
        if (status === 429) throw new Error('Quota API esaurita. Attendi qualche minuto e riprova, oppure controlla i limiti su aistudio.google.com.');
        if (status === 400) throw new Error('API key non valida o richiesta malformata. Controlla la chiave in Impostazioni AI.');
        if (status === 403) throw new Error('API key non autorizzata. Assicurati di aver abilitato Generative Language API su aistudio.google.com.');
        throw new Error(err.error?.message || `Errore API Gemini (${status})`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const ANALYSIS_PROMPT = `Analizza questa foto di un pasto e proponi una stima indicativa dei valori nutrizionali, da verificare con l'utente.

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
- Non trattare la foto come una misurazione: se manca una scala, chiedi un riferimento (diametro del piatto, peso della confezione o frazione mangiata)
- Per piatti composti, chiedi chiarimenti su ingredienti e condimenti non visibili quando influenzano la stima
- Specifica nelle note se stai stimando il peso del cibo cotto
- "confidenza" può essere "alta", "media" o "bassa"
- Se sei incerto, inserisci massimo 2 domande brevi e specifiche in "domande_chiarimento"
- Se sei abbastanza sicuro, lascia "domande_chiarimento" come array vuoto []
- I valori nutrizionali devono essere per 100g di prodotto
- Rispondi sempre in italiano`;

export async function analyzePhoto(apiKey, imageBase64, mimeType) {
    const contents = [{
        role: 'user',
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
            role: 'user',
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
    const candidates = [clean, clean.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], clean.match(/\{[\s\S]*\}/)?.[0]];
    let parsed;
    for (const candidate of candidates.filter(Boolean)) {
        try { parsed = JSON.parse(candidate); break; } catch {}
    }
    const validNumber = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
        && Number.isFinite(Number(value)) && Number(value) >= 0;
    const values = parsed?.valori_per_100g;
    if (!parsed || typeof parsed.alimento !== 'string' || !parsed.alimento.trim()
        || !validNumber(parsed.quantita_stimata_g) || Number(parsed.quantita_stimata_g) <= 0
        || !values || !['calorie', 'proteine', 'carboidrati', 'grassi'].every(key => validNumber(values[key]))
        || (values.fibre !== undefined && !validNumber(values.fibre))) {
        throw new Error('La stima ricevuta è incompleta o non valida. Riprova con una foto più chiara.');
    }
    return {
        alimento: parsed.alimento.trim(),
        quantita_stimata_g: Number(parsed.quantita_stimata_g),
        valori_per_100g: Object.fromEntries(['calorie', 'proteine', 'carboidrati', 'grassi', 'fibre'].map(key => [key, Number(values[key] ?? 0)])),
        confidenza: ['alta', 'media', 'bassa'].includes(parsed.confidenza) ? parsed.confidenza : 'bassa',
        domande_chiarimento: Array.isArray(parsed.domande_chiarimento) ? parsed.domande_chiarimento.filter(q => typeof q === 'string').slice(0, 2) : [],
        note: typeof parsed.note === 'string' ? parsed.note : ''
    };
}
