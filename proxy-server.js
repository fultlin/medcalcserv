const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// --- Вспомогательная функция для логирования ошибок ---
const handleErr = (res, err, context) => {
  console.error(`!!! ERROR в ${context}:`, err.message);
  // Если это ошибка fetch, выведем подробности
  if (err.cause) console.error('Причина:', err.cause);
  res.status(500).json({ error: err.message, context });
};

// --- БЛОК YANDEX ---
app.post('/iam', async (req, res) => {
  try {
    const { oauthToken } = req.body;
    const iamRes = await fetch('https://iam.api.cloud.yandex.net/iam/v1/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yandexPassportOauthToken: oauthToken }),
    });
    const json = await iamRes.json();
    res.json(json);
  } catch (err) { handleErr(res, err, 'IAM'); }
});

app.post('/gpt-proxy', async (req, res) => {
  try {
    const { prompt, iamToken, folderId } = req.body;
    console.log(`>>> Запрос к GPT для папки: ${folderId}`);
    
    const yandexRes = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${iamToken}`,
      },
      body: JSON.stringify({
        modelUri: `gpt://${folderId}/yandexgpt/latest`,
        completionOptions: { temperature: 0.3, maxTokens: 1000 },
        messages: [{ role: 'user', text: prompt }],
      }),
    });
    
    const data = await yandexRes.json();
    if (data.error) throw new Error(`Yandex API error: ${JSON.stringify(data.error)}`);
    res.json(data);
  } catch (err) { handleErr(res, err, 'GPT'); }
});

// --- БЛОК PUBMED ---
const pubmedCache = new Map(); // Кэш для результатов

app.get('/pubmed', async (req, res) => {
  try {
    const { term, retmax = 3 } = req.query;
    
    // Если искали это менее 5 секунд назад — отдаем из кэша
    if (pubmedCache.has(term)) {
      const cached = pubmedCache.get(term);
      if (Date.now() - cached.time < 5000) {
        console.log(`>>> PubMed: отдаем из кэша для "${term}"`);
        return res.json(cached.data);
      }
    }

    console.log(`>>> Поиск PubMed: ${term}`);
    const searchRes = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&term=${encodeURIComponent(term)}`
    );
    const searchJson = await searchRes.json();
    
    // Если PubMed прислал ошибку лимита, не падаем, а вежливо отвечаем
    if (searchJson.error === 'API rate limit exceeded') {
      console.error("!!! PubMed: Лимит запросов превышен");
      return res.status(429).json({ error: "PubMed limit exceeded. Wait a second." });
    }

    const ids = searchJson?.esearchresult?.idlist || [];
    if (ids.length === 0) return res.json([]);

    const summaryRes = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`
    );
    const summaryJson = await summaryRes.json();

    const articles = ids.map(id => {
      const doc = summaryJson.result ? summaryJson.result[id] : null;
      return {
        id,
        title: doc.title || 'No title',
        authors: doc.authors?.map(a => a.name).join(', ') || 'N/A',
        journal: doc.source || 'N/A',
        year: doc.pubdate ? doc.pubdate.slice(0, 4) : 'N/A',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}`,
      };
    });

    // Сохраняем в кэш
    pubmedCache.set(term, { data: articles, time: Date.now() });
    res.json(articles);

  } catch (err) {
    console.error("!!! PubMed Proxy Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));